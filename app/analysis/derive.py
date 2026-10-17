"""从原始数据集派生规范化事实表：回合、每人每回合、每人每场、击杀明细、武器。

为什么要自己推阵营（M0 / 方案 §0.3 实测）：players.side 是「最后一次观测到的阵营」，
每人整场只有一个值，半场换边后一半回合都是错的。分阵营统计与队伍胜负必须逐回合重算：

1. 观测：kills / damages / item_events / shots / blinds 的每一行都带 (steamid, side, tick)，
   按 tick 归回合后对每个 (玩家, 回合) 投票取多数。
2. 分队：两名玩家在共同回合里阵营一致的次数多于不一致 → 同队。以观测最多的玩家为锚，
   逐个挂到已分队玩家上，得到 A/B 两队（A = 首个有观测回合里站 CT 的那队）。
3. 队伍阵营：每回合用全部队员的观测给 A 队投票；无观测的回合沿用相邻回合。
   玩家阵营一律取所在队伍的阵营，单条观测的噪声（换边瞬间的事件）被多数票吸收。

所有函数只读 dict 的 .get()，缺列只会让对应指标变 0，不会抛错 —— 这是对解析器升级的防线。
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from .common import CT, T, RoundIndex, clean_sid, flip, norm_side, round_end_tick, weapon_key
from .metrics import MULTIKILL_EMPTY, approximate_rating, multikills

# 派生口径版本：本文件或 highlights.py 的口径变化时 +1，旧场次会在后台按存档的原始数据集重算
DERIVE_VERSION = 3

UTILITY_WEAPONS = {"hegrenade", "molotov", "incgrenade", "inferno", "flashbang", "smokegrenade", "decoy"}

OBS_SOURCES = (
    ("kills", "attacker_steamid", "attacker_side"),
    ("kills", "victim_steamid", "victim_side"),
    ("kills", "assister_steamid", "assister_side"),
    ("damages", "attacker_steamid", "attacker_side"),
    ("damages", "victim_steamid", "victim_side"),
    ("item_events", "steamid", "side"),
    ("shots", "steamid", "side"),
    ("blinds", "attacker_steamid", "attacker_side"),
    ("blinds", "victim_steamid", "victim_side"),
)

# player_match 里直接沿用 awpy stats 的列（存在就用，缺了用自算值兜底）
AWPY_STAT_COLS = (
    "rounds_played", "kills", "deaths", "assists", "flash_assists", "headshot_kills", "headshot_pct",
    "opening_kills", "opening_deaths", "traded_deaths", "multikill_2k", "multikill_3k", "multikill_4k",
    "multikill_5k", "kast", "adr", "clutches_played", "clutches_won", "clutch_1v1", "clutch_1v2",
    "clutch_1v3", "clutch_1v4", "clutch_1v5", "utility_damage", "flashes_thrown", "enemies_flashed",
    "flash_duration_dealt",
)


@dataclass
class Derived:
    rounds: list[dict] = field(default_factory=list)
    player_round: list[dict] = field(default_factory=list)
    player_match: list[dict] = field(default_factory=list)
    kills: list[dict] = field(default_factory=list)
    player_weapon: list[dict] = field(default_factory=list)
    teams: dict[str, dict] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- 阵营推断

@dataclass
class SideModel:
    team_of: dict[str, str]                 # steamid -> 'A' / 'B'
    team_side: dict[tuple[str, int], str]   # (team, round_num) -> side
    present: dict[str, tuple[int, int]]     # steamid -> (首个, 最后) 有观测的回合
    observed: dict[tuple[str, int], str]    # (steamid, round_num) -> 该玩家自己的多数观测

    def side_of(self, steamid: str | None, round_num: int) -> str | None:
        team = self.team_of.get(steamid or "")
        return self.team_side.get((team, round_num)) if team else None

    def is_present(self, steamid: str, round_num: int) -> bool:
        span = self.present.get(steamid)
        return bool(span) and span[0] <= round_num <= span[1]


def infer_sides(datasets: dict[str, list[dict]], index: RoundIndex, round_nums: list[int]) -> SideModel:
    votes: dict[tuple[str, int], Counter] = defaultdict(Counter)
    for name, sid_col, side_col in OBS_SOURCES:
        for row in datasets.get(name) or ():
            sid = clean_sid(row.get(sid_col))
            side = norm_side(row.get(side_col))
            if not sid or not side:
                continue
            rnd = index.round_of(row.get("tick"))
            if rnd is not None:
                votes[(sid, rnd)][side] += 1

    observed = {key: c.most_common(1)[0][0] for key, c in votes.items()}
    by_player: dict[str, dict[int, str]] = defaultdict(dict)
    for (sid, rnd), side in observed.items():
        by_player[sid][rnd] = side

    # 分队：锚 = 观测回合最多的玩家；其余玩家挂到与其共同回合最多的已分队玩家
    team_of: dict[str, str] = {}
    order = sorted(by_player, key=lambda s: (-len(by_player[s]), s))
    if order:
        team_of[order[0]] = "X"
        pending = order[1:]
        while pending:
            progressed = False
            for sid in list(pending):
                best, best_overlap, same = None, 0, True
                for ref in team_of:
                    common = by_player[sid].keys() & by_player[ref].keys()
                    if len(common) > best_overlap:
                        agree = sum(1 for r in common if by_player[sid][r] == by_player[ref][r])
                        best, best_overlap, same = ref, len(common), agree * 2 >= len(common)
                if best is None:
                    continue
                ref_team = team_of[best]
                team_of[sid] = ref_team if same else ("Y" if ref_team == "X" else "X")
                pending.remove(sid)
                progressed = True
            if not progressed:
                break  # 与任何人都没有共同回合的玩家（例如只出现在热身里）不分队

    # X 队逐回合阵营投票
    x_votes: dict[int, Counter] = defaultdict(Counter)
    for sid, team in team_of.items():
        for rnd, side in by_player[sid].items():
            x_votes[rnd][side if team == "X" else flip(side)] += 1
    x_side: dict[int, str] = {r: c.most_common(1)[0][0] for r, c in x_votes.items()}
    filled: dict[int, str] = {}
    last = None
    for rnd in round_nums:
        last = x_side.get(rnd, last)
        if last is not None:
            filled[rnd] = last
    nxt = None
    for rnd in reversed(round_nums):  # 开头几回合没观测时，用后面的回合回填
        if rnd in filled:
            nxt = filled[rnd]
        elif nxt is not None:
            filled[rnd] = nxt

    # 命名：A = 第一回合站 CT 的队
    first_x = next((filled[r] for r in round_nums if r in filled), CT)
    rename = {"X": "A", "Y": "B"} if first_x == CT else {"X": "B", "Y": "A"}
    team_side: dict[tuple[str, int], str] = {}
    for rnd, side in filled.items():
        team_side[(rename["X"], rnd)] = side
        team_side[(rename["Y"], rnd)] = flip(side)

    present = {sid: (min(rs), max(rs)) for sid, rs in by_player.items() if rs}
    return SideModel(
        team_of={sid: rename[t] for sid, t in team_of.items()},
        team_side=team_side,
        present=present,
        observed=observed,
    )


# --------------------------------------------------------------------------- 主流程

def _by_round(rows: list[dict] | None, index: RoundIndex) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = defaultdict(list)
    for row in rows or ():
        rnd = index.round_of(row.get("tick"))
        if rnd is not None:
            out[rnd].append(row)
    for lst in out.values():
        lst.sort(key=lambda r: r.get("tick") or 0)
    return out


def _names(datasets: dict[str, list[dict]]) -> dict[str, str]:
    names: dict[str, str] = {}
    for row in datasets.get("kills") or ():
        for who in ("attacker", "victim"):
            sid = clean_sid(row.get(f"{who}_steamid"))
            if sid and row.get(f"{who}_name"):
                names[sid] = row[f"{who}_name"]
    for name in ("stats", "players"):  # 名册优先级最高，最后覆盖
        for row in datasets.get(name) or ():
            sid = clean_sid(row.get("steamid"))
            if sid and row.get("name"):
                names[sid] = row["name"]
    return names


def derive_match(datasets: dict[str, list[dict]]) -> Derived:
    out = Derived()
    raw_rounds = sorted((r for r in datasets.get("rounds") or () if r.get("round_num") is not None),
                        key=lambda r: r["round_num"])
    if not raw_rounds:
        out.warnings.append("rounds 数据集为空，无法派生回合级数据")
        return out
    index = RoundIndex(raw_rounds)
    knife = {r["round_num"] for r in raw_rounds if r.get("is_knife_round")}
    playable = [r for r in raw_rounds if r["round_num"] not in knife]
    round_nums = [r["round_num"] for r in playable]
    model = infer_sides(datasets, index, round_nums)
    if not model.team_of:
        out.warnings.append("没有任何带阵营的事件，无法分队")
    names = _names(datasets)

    kills_by_round = _by_round(datasets.get("kills"), index)
    damage_by_round = _by_round(datasets.get("damages"), index)
    items_by_round = _by_round(datasets.get("item_events"), index)
    economy = {(e.get("round_num"), norm_side(e.get("side"))): e for e in datasets.get("round_economy") or ()}

    pr: dict[tuple[str, int], dict] = {}
    score = {"A": 0, "B": 0}

    for r in playable:
        rnd = r["round_num"]
        winner = norm_side(r.get("winner_side"))
        side_a = model.team_side.get(("A", rnd))
        if winner and side_a:
            score["A" if winner == side_a else "B"] += 1
        out.rounds.append({
            "round_num": rnd,
            "start_tick": r.get("start_tick"),
            "freeze_end_tick": r.get("freeze_end_tick"),
            "end_tick": r.get("end_tick"),
            "official_end_tick": r.get("official_end_tick"),
            "winner_side": winner,
            "reason_name": r.get("reason_name"),
            "team_a_side": side_a,
            "score_a": score["A"],
            "score_b": score["B"],
            "ct_equipment": (economy.get((rnd, CT)) or {}).get("equipment_value"),
            "t_equipment": (economy.get((rnd, T)) or {}).get("equipment_value"),
            "ct_buy": (economy.get((rnd, CT)) or {}).get("buy_type"),
            "t_buy": (economy.get((rnd, T)) or {}).get("buy_type"),
        })

        members = [sid for sid in model.team_of if model.is_present(sid, rnd)]
        for sid in members:
            side = model.side_of(sid, rnd)
            pr[(sid, rnd)] = {
                "round_num": rnd, "steamid": sid, "team": model.team_of[sid], "side": side,
                "kills": 0, "deaths": 0, "assists": 0, "damage": 0, "util_damage": 0, "headshots": 0,
                "survived": 1, "traded": 0, "trade_kills": 0, "kast": 0,
                "opening_kill": 0, "opening_death": 0, "won": int(bool(winner) and side == winner),
                "clutch_vs": 0, "clutch_won": 0, "spent": 0,
            }
        alive = {CT: {s for s in members if model.side_of(s, rnd) == CT},
                 T: {s for s in members if model.side_of(s, rnd) == T}}
        clutcher: dict[str, tuple[str, int]] = {}
        opened = False

        for kill in kills_by_round.get(rnd, ()):
            atk, vic = clean_sid(kill.get("attacker_steamid")), clean_sid(kill.get("victim_steamid"))
            ast = clean_sid(kill.get("assister_steamid"))
            a_side = model.side_of(atk, rnd) or norm_side(kill.get("attacker_side"))
            v_side = model.side_of(vic, rnd) or norm_side(kill.get("victim_side"))
            enemy = bool(atk and vic and atk != vic and a_side and v_side and a_side != v_side)
            teamkill = bool(atk and vic and atk != vic and a_side and a_side == v_side)
            out.kills.append({
                "round_num": rnd, "tick": kill.get("tick"),
                "attacker_steamid": atk, "attacker_name": kill.get("attacker_name"), "attacker_side": a_side,
                "victim_steamid": vic, "victim_name": kill.get("victim_name"), "victim_side": v_side,
                "assister_steamid": ast, "weapon": weapon_key(kill.get("weapon")),
                "headshot": int(bool(kill.get("headshot"))), "noscope": int(bool(kill.get("noscope"))),
                "thrusmoke": int(bool(kill.get("thrusmoke"))), "penetrated": int(bool(kill.get("penetrated"))),
                "attackerblind": int(bool(kill.get("attackerblind"))),
                "is_trade": int(bool(kill.get("is_trade"))), "victim_traded": int(bool(kill.get("victim_traded"))),
                "is_teamkill": int(teamkill),
                "attacker_x": kill.get("attacker_x"), "attacker_y": kill.get("attacker_y"),
                "victim_x": kill.get("victim_x"), "victim_y": kill.get("victim_y"),
            })
            if vic and (vic, rnd) in pr:
                row = pr[(vic, rnd)]
                row["deaths"] += 1
                row["survived"] = 0
                if kill.get("victim_traded"):
                    row["traded"] = 1
            if enemy and (atk, rnd) in pr:
                row = pr[(atk, rnd)]
                row["kills"] += 1
                row["headshots"] += int(bool(kill.get("headshot")))
                row["trade_kills"] += int(bool(kill.get("is_trade")))
                if not opened:
                    row["opening_kill"] = 1
            if enemy and not opened:
                opened = True
                if (vic, rnd) in pr:
                    pr[(vic, rnd)]["opening_death"] = 1
            if enemy and ast and ast not in (atk, vic) and (ast, rnd) in pr and model.side_of(ast, rnd) == a_side:
                pr[(ast, rnd)]["assists"] += 1
            # 残局：某方只剩 1 人且对面还有人时，记下这名残局玩家与对手人数（每方每回合只记第一次）
            if vic and v_side in alive:
                alive[v_side].discard(vic)
            for side in (CT, T):
                if side not in clutcher and len(alive[side]) == 1 and alive[flip(side)]:
                    clutcher[side] = (next(iter(alive[side])), len(alive[flip(side)]))

        for side, (sid, vs) in clutcher.items():
            if (sid, rnd) in pr:
                pr[(sid, rnd)]["clutch_vs"] = vs
                pr[(sid, rnd)]["clutch_won"] = int(winner == side)

        for dmg in damage_by_round.get(rnd, ()):
            atk, vic = clean_sid(dmg.get("attacker_steamid")), clean_sid(dmg.get("victim_steamid"))
            if not atk or not vic or atk == vic or (atk, rnd) not in pr:
                continue
            a_side = model.side_of(atk, rnd) or norm_side(dmg.get("attacker_side"))
            v_side = model.side_of(vic, rnd) or norm_side(dmg.get("victim_side"))
            if not a_side or a_side == v_side:
                continue
            amount = dmg.get("dmg_health") or 0
            pre = dmg.get("health_pre")
            if pre is not None:  # ADR 口径：每一击封顶为受害者剩余血量（awpy reference 同口径）
                amount = min(amount, pre)
            pr[(atk, rnd)]["damage"] += amount
            if weapon_key(dmg.get("weapon")) in UTILITY_WEAPONS:
                pr[(atk, rnd)]["util_damage"] += amount

        for item in items_by_round.get(rnd, ()):
            sid = clean_sid(item.get("steamid"))
            if item.get("action") == "purchase" and (sid, rnd) in pr:
                pr[(sid, rnd)]["spent"] += item.get("cost") or 0

        for sid in members:
            row = pr[(sid, rnd)]
            row["kast"] = int(bool(row["kills"] or row["assists"] or row["survived"] or row["traded"]))

    out.player_round = sorted(pr.values(), key=lambda r: (r["round_num"], r["team"], r["steamid"]))
    out.player_weapon = _player_weapons(datasets, model, index, set(round_nums))
    out.player_match = _player_match(datasets, out, model, names, score)

    team_names: dict[str, Counter] = defaultdict(Counter)
    for row in datasets.get("players") or ():
        sid = clean_sid(row.get("steamid"))
        if sid in model.team_of and row.get("team_clan_name"):
            team_names[model.team_of[sid]][row["team_clan_name"]] += 1
    for team in ("A", "B"):
        out.teams[team] = {
            "team": team,
            "start_side": model.team_side.get((team, round_nums[0])) if round_nums else None,
            "score": score[team],
            "name": team_names[team].most_common(1)[0][0] if team_names[team] else None,
            "members": sorted(s for s, t in model.team_of.items() if t == team),
        }
    for team in ("A", "B"):
        n = len(out.teams[team]["members"])
        if n and n != 5:
            out.warnings.append(f"队伍 {team} 有 {n} 名玩家（非 5 人，可能有中途换人或非 5v5 模式）")
    return out


def _player_weapons(datasets: dict, model: SideModel, index: RoundIndex, playable: set[int]) -> list[dict]:
    agg: dict[tuple[str, str], dict] = {}

    def bucket(sid: str, weapon: str) -> dict:
        key = (sid, weapon)
        if key not in agg:
            agg[key] = {"steamid": sid, "weapon": weapon, "shots": 0, "hits": 0, "damage": 0, "kills": 0, "headshots": 0}
        return agg[key]

    for row in datasets.get("shots") or ():
        sid, weapon = clean_sid(row.get("steamid")), weapon_key(row.get("weapon"))
        if sid in model.team_of and weapon and index.round_of(row.get("tick")) in playable:
            bucket(sid, weapon)["shots"] += 1
    for row in datasets.get("damages") or ():
        atk, vic = clean_sid(row.get("attacker_steamid")), clean_sid(row.get("victim_steamid"))
        rnd = index.round_of(row.get("tick"))
        weapon = weapon_key(row.get("weapon"))
        if atk not in model.team_of or not vic or atk == vic or rnd not in playable or not weapon:
            continue
        if model.team_of.get(vic) == model.team_of[atk]:
            continue
        amount = row.get("dmg_health") or 0
        if row.get("health_pre") is not None:
            amount = min(amount, row["health_pre"])
        b = bucket(atk, weapon)
        b["hits"] += 1
        b["damage"] += amount
    for row in datasets.get("kills") or ():
        atk, vic = clean_sid(row.get("attacker_steamid")), clean_sid(row.get("victim_steamid"))
        rnd = index.round_of(row.get("tick"))
        weapon = weapon_key(row.get("weapon"))
        if atk not in model.team_of or not vic or atk == vic or rnd not in playable or not weapon:
            continue
        if model.team_of.get(vic) == model.team_of[atk]:
            continue
        b = bucket(atk, weapon)
        b["kills"] += 1
        b["headshots"] += int(bool(row.get("headshot")))
    return sorted(agg.values(), key=lambda b: (b["steamid"], -b["kills"], b["weapon"]))


def _player_match(datasets: dict, out: Derived, model: SideModel, names: dict[str, str],
                  score: dict[str, int]) -> list[dict]:
    stats = {clean_sid(s.get("steamid")): s for s in datasets.get("stats") or ()}
    roster = {clean_sid(p.get("steamid")): p for p in datasets.get("players") or ()}
    multi = multikills(datasets.get("kills") or [], [r for r in datasets.get("rounds") or ()
                                                     if not r.get("is_knife_round")])
    sums: dict[str, Counter] = defaultdict(Counter)
    for row in out.player_round:
        c = sums[row["steamid"]]
        c["rounds"] += 1
        c[f"rounds_{'ct' if row['side'] == CT else 't'}"] += 1
        for key in ("kills", "deaths", "assists", "damage", "util_damage", "headshots", "kast", "won",
                    "opening_kill", "opening_death", "traded", "trade_kills", "spent", "clutch_won"):
            c[key] += row[key]
        c["clutches"] += int(row["clutch_vs"] > 0)

    first_round = out.rounds[0]["round_num"] if out.rounds else None
    rows = []
    for sid, team in model.team_of.items():
        c = sums.get(sid, Counter())
        n = c["rounds"]
        calc = {
            "rounds_played": n, "kills": c["kills"], "deaths": c["deaths"], "assists": c["assists"],
            "headshot_kills": c["headshots"],
            "headshot_pct": round(100.0 * c["headshots"] / c["kills"], 2) if c["kills"] else 0.0,
            "opening_kills": c["opening_kill"], "opening_deaths": c["opening_death"],
            "traded_deaths": c["traded"], "clutches_played": c["clutches"], "clutches_won": c["clutch_won"],
            "kast": round(100.0 * c["kast"] / n, 2) if n else 0.0,
            "adr": round(c["damage"] / n, 2) if n else 0.0,
            "utility_damage": c["util_damage"],
        }
        mk = multi.get(sid, MULTIKILL_EMPTY)
        calc.update({"multikill_2k": mk["2k"], "multikill_3k": mk["3k"], "multikill_4k": mk["4k"],
                     "multikill_5k": mk["5k"]})
        awpy = stats.get(sid) or {}
        row = {"steamid": sid, "name": names.get(sid) or awpy.get("name") or sid, "team": team}
        for col in AWPY_STAT_COLS:
            value = awpy.get(col)
            row[col] = value if value is not None else calc.get(col, 0)
        row["stats_source"] = "awpy" if awpy else "derived"
        row["rating"] = approximate_rating(row)
        row.update({"mk_2k": mk["2k"], "mk_3k": mk["3k"], "mk_4k": mk["4k"], "mk_5k": mk["5k"]})
        own, opp = score[team], score["B" if team == "A" else "A"]
        row.update({
            "team_name": (roster.get(sid) or {}).get("team_clan_name"),
            "last_side": norm_side((roster.get(sid) or {}).get("side")),
            "start_side": model.team_side.get((team, first_round)) if first_round is not None else None,
            "team_score": own, "opp_score": opp,
            "result": "W" if own > opp else ("L" if own < opp else "T"),
            "rounds_won": c["won"], "rounds_ct": c["rounds_ct"], "rounds_t": c["rounds_t"],
            "damage": c["damage"], "adr_calc": calc["adr"], "kast_calc": calc["kast"],
            "trade_kills": c["trade_kills"], "spent": c["spent"],
        })
        rows.append(row)
    rows.sort(key=lambda r: (-(r["rating"] or 0), r["steamid"]))
    return rows


def side_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """把若干 player_round 行聚合成一组指标（分阵营 / 分地图共用）。"""
    n = len(rows)
    if not n:
        return {"rounds": 0}
    s = Counter()
    for r in rows:
        for k in ("kills", "deaths", "assists", "damage", "kast", "won", "opening_kill", "opening_death",
                  "headshots", "clutch_won"):
            s[k] += r.get(k) or 0
        s["clutches"] += int((r.get("clutch_vs") or 0) > 0)
    adr = s["damage"] / n
    kast = 100.0 * s["kast"] / n
    return {
        "rounds": n, "kills": s["kills"], "deaths": s["deaths"], "assists": s["assists"],
        "adr": round(adr, 2), "kast": round(kast, 2), "round_win_pct": round(100.0 * s["won"] / n, 2),
        "kd": round(s["kills"] / s["deaths"], 3) if s["deaths"] else float(s["kills"]),
        "opening_kills": s["opening_kill"], "opening_deaths": s["opening_death"],
        "headshot_pct": round(100.0 * s["headshots"] / s["kills"], 2) if s["kills"] else 0.0,
        "clutches": s["clutches"], "clutches_won": s["clutch_won"],
        "rating": approximate_rating({"rounds_played": n, "kills": s["kills"], "deaths": s["deaths"],
                                      "assists": s["assists"], "kast": kast, "adr": adr}),
    }
