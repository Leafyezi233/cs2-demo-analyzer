"""合成比赛生成器：按 awpy 3.0 的列名造一场「像真的」比赛，并给出标准答案。

用途：
- 单元测试：没有真实 demo 也能验证阵营推断、分队、ADR/KAST、多杀、残局、高光。
- 前端预览：tools/seed_demo_data.py 用它批量造库，方便截图与界面自测。

生成规则（MR12，第 12 回合后换边，打满 24 回合或一方先到 13）：
- 每回合按两队实力随机胜负，败方全灭，胜方随机阵亡 0~4 人。
- 每个击杀配套 1~3 条伤害（总和恰好 100，带 health_pre）、若干射击、可选助攻。
- 冻结时间里每人一条购买记录，round_economy 按购买汇总。
- stats 由生成过程直接统计（不经过 derive.py），作为交叉校验的标准答案。
"""
from __future__ import annotations

import random
from collections import defaultdict

CT, T = "counter-terrorist", "terrorist"
RIFLES = {CT: ["m4a1_silencer", "m4a1", "famas", "awp"], T: ["ak47", "galilar", "ak47", "awp"]}
PISTOLS = {CT: ["usp_silencer", "p250", "fiveseven"], T: ["glock", "p250", "tec9"]}
NAMES_A = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
NAMES_B = ["Foxtrot", "Golf", "Hotel", "India", "Juliet"]
TICK_RATE = 64


def steamid(i: int) -> str:
    return str(76561198000000000 + i)


def make_match(seed: int = 1, map_name: str = "de_mirage", skill_a: float = 1.0, skill_b: float = 1.0,
               hero_boost: float = 0.0, knife_round: bool = False, teamkill_round: int | None = None,
               noise: bool = True, player_offset: int = 0) -> tuple[dict, dict]:
    """返回 (parsed, truth)。parsed 的形状与 app.parser.parse() 一致。

    hero_boost：给 A 队第一名玩家（steamid(player_offset+1)）额外的对枪权重。
    player_offset：用不同的偏移可以造出「我」在另一批路人中的比赛。
    """
    rng = random.Random(seed)
    team_a = [steamid(player_offset + i + 1) for i in range(5)]
    team_b = [steamid(player_offset + i + 101) for i in range(5)]
    names = {sid: NAMES_A[i] for i, sid in enumerate(team_a)} | {sid: NAMES_B[i] for i, sid in enumerate(team_b)}
    weight = {sid: 1.0 for sid in team_a + team_b}
    weight[team_a[0]] += hero_boost

    rounds, kills, damages, shots, items, economy = [], [], [], [], [], []
    truth_pr: dict[tuple[str, int], dict] = {}
    tick = 200
    score = {"A": 0, "B": 0}
    rnd = 0

    if knife_round:
        rounds.append({"round_num": 1, "start_tick": tick, "freeze_end_tick": tick + 64 * 5, "end_tick": tick + 64 * 40,
                       "official_end_tick": tick + 64 * 45, "winner": 3, "winner_side": CT, "reason": 9,
                       "reason_name": "t_killed", "is_knife_round": True})
        tick += 64 * 50
        rnd = 1

    played = 0
    while played < 24 and max(score.values()) < 13:
        played += 1
        rnd += 1
        a_side = CT if played <= 12 else T
        side_of = {sid: a_side for sid in team_a} | {sid: (T if a_side == CT else CT) for sid in team_b}
        start = tick
        freeze_end = start + 64 * 15
        strength_a = skill_a * sum(weight[s] for s in team_a)
        strength_b = skill_b * sum(weight[s] for s in team_b)
        winner_team = "A" if rng.random() < strength_a / (strength_a + strength_b) else "B"
        winner_side = a_side if winner_team == "A" else (T if a_side == CT else CT)
        winners = team_a if winner_team == "A" else team_b
        losers = team_b if winner_team == "A" else team_a
        winner_deaths = rng.randint(0, 4)

        pistol = played in (1, 13)
        for sid in team_a + team_b:
            side = side_of[sid]
            weapon = rng.choice(PISTOLS[side]) if pistol else rng.choice(RIFLES[side])
            cost = 200 if pistol else (4750 if weapon == "awp" else 2900)
            items.append({"tick": start + 64 * 3, "action": "purchase", "entity_id": 1, "entity_serial": 1,
                          "steamid": sid, "name": names[sid], "side": side, "item": weapon, "x": 0.0, "y": 0.0,
                          "z": 0.0, "original_owner_steamid": sid, "cost": cost, "near_buy_zone": None})
            truth_pr[(sid, rnd)] = {"side": side, "kills": 0, "deaths": 0, "assists": 0, "damage": 0,
                                    "survived": 1, "traded": 0, "won": int(side == winner_side), "kast": 0}
        for side in (CT, T):
            members = [s for s in team_a + team_b if side_of[s] == side]
            value = sum(i["cost"] for i in items if i["tick"] == start + 64 * 3 and i["steamid"] in members)
            economy.append({"round_num": rnd, "side": side, "equipment_value": value,
                            "buy_type": "pistol" if pistol else ("full" if value >= 20000 else "force"),
                            "n_players": 5})

        alive = {"W": list(winners), "L": list(losers)}
        # 死亡顺序：败方 5 人 + 胜方若干人随机穿插，但败方最后一人一定最后倒下
        order = ["L"] * 5
        for _ in range(winner_deaths):
            order.insert(rng.randint(0, len(order) - 1), "W")
        t = freeze_end + 64 * rng.randint(8, 25)
        recent_deaths: list[tuple[int, str, str]] = []  # (tick, victim, killer)
        for who in order:
            t += 64 * rng.randint(1, 9) + rng.randint(0, 63)
            vic_pool, atk_pool = (alive["L"], alive["W"]) if who == "L" else (alive["W"], alive["L"])
            if not vic_pool or not atk_pool:
                continue
            victim = rng.choice(vic_pool)
            attacker = rng.choices(atk_pool, weights=[weight[s] for s in atk_pool])[0]
            vic_pool.remove(victim)
            weapon = rng.choice(PISTOLS[side_of[attacker]] if pistol else RIFLES[side_of[attacker]])
            headshot = rng.random() < 0.35 + 0.1 * (weight[attacker] - 1)
            assister = None
            mates = [s for s in atk_pool if s != attacker]
            if mates and rng.random() < 0.3:
                assister = rng.choice(mates)
            is_trade = False
            for i, (dt, dv, dk) in enumerate(recent_deaths):
                if dk == victim and side_of[dv] == side_of[attacker] and t - dt <= 5.25 * 64:
                    is_trade = True
                    for k in kills:
                        if k["tick"] == dt and k["victim_steamid"] == dv:
                            k["victim_traded"] = True
                            truth_pr[(dv, rnd)]["traded"] = 1
                    recent_deaths.pop(i)
                    break
            recent_deaths.append((t, victim, attacker))
            kills.append(_kill(attacker, victim, assister, side_of, names, weapon, headshot, t, is_trade, rng))
            # 伤害：助攻者先打 30，击杀者补满
            health = 100
            if assister:
                damages.append(_damage(assister, victim, side_of, names, weapon, 30, health, t - 64))
                truth_pr[(assister, rnd)]["damage"] += 30
                truth_pr[(assister, rnd)]["assists"] += 1
                health -= 30
            hits = [health] if health <= 40 else [rng.randint(15, health - 20), None]
            if len(hits) == 2:
                hits[1] = health - hits[0]
            for j, amount in enumerate(hits):
                damages.append(_damage(attacker, victim, side_of, names, weapon, amount, health, t - (len(hits) - j - 1) * 8))
                health -= amount
            truth_pr[(attacker, rnd)]["damage"] += 100 - (30 if assister else 0)
            truth_pr[(attacker, rnd)]["kills"] += 1
            truth_pr[(victim, rnd)]["deaths"] += 1
            truth_pr[(victim, rnd)]["survived"] = 0
            for s in range(rng.randint(2, 6)):
                shots.append({"tick": t - 8 * (s + 1), "entity_id": 1, "entity_serial": 1, "steamid": attacker,
                              "name": names[attacker], "side": side_of[attacker], "x": 0.0, "y": 0.0, "z": 0.0,
                              "pitch": 0.0, "yaw": 0.0, "weapon": "weapon_" + weapon, "scoped": False,
                              "inaccuracy": 0.01, "num_bullets_remaining": 20})
        # 非致命的擦伤：给一名存活的胜方玩家 12 点伤害（来自已阵亡的败方，体现 ADR 不只来自击杀）
        if alive["W"]:
            chip_victim = alive["W"][0]
            chip_attacker = losers[0]
            damages.append(_damage(chip_attacker, chip_victim, side_of, names, "hegrenade", 12, 100, freeze_end + 64 * 6))
            truth_pr[(chip_attacker, rnd)]["damage"] += 12

        if teamkill_round == played:
            tk_atk, tk_vic = alive["W"][0] if len(alive["W"]) > 1 else None, alive["W"][-1] if len(alive["W"]) > 1 else None
            if tk_atk and tk_vic and tk_atk != tk_vic:
                t += 64
                kills.append(_kill(tk_atk, tk_vic, None, side_of, names, "ak47", False, t, False, rng))
                truth_pr[(tk_vic, rnd)]["deaths"] += 1
                truth_pr[(tk_vic, rnd)]["survived"] = 0
                alive["W"].remove(tk_vic)

        end = t + 64 * 2
        last = played == 24 or max(score["A"] + (winner_team == "A"), score["B"] + (winner_team == "B")) >= 13
        rounds.append({"round_num": rnd, "start_tick": start, "freeze_end_tick": freeze_end, "end_tick": end,
                       "official_end_tick": None if last else end + 64 * 7,
                       "winner": 3 if winner_side == CT else 2, "winner_side": winner_side,
                       "reason": 9, "reason_name": "ct_killed" if winner_side == T else "t_killed",
                       "is_knife_round": False})
        score[winner_team] += 1
        if noise and played == 13:
            # 换边瞬间的脏数据：一条阵营还是上半场的掉落记录（真实 demo 里会出现）
            items.append({"tick": start + 64 * 4, "action": "drop", "entity_id": 1, "entity_serial": 1,
                          "steamid": team_a[1], "name": names[team_a[1]], "side": CT, "item": "knife",
                          "x": 0.0, "y": 0.0, "z": 0.0, "original_owner_steamid": team_a[1], "cost": None,
                          "near_buy_zone": True})
        tick = end + 64 * 12

    for row in truth_pr.values():
        row["kast"] = int(bool(row["kills"] or row["assists"] or row["survived"] or row["traded"]))

    stats = []
    for sid in team_a + team_b:
        rows = [v for (s, _r), v in truth_pr.items() if s == sid]
        n = len(rows)
        k = sum(r["kills"] for r in rows)
        stats.append({
            "steamid": sid, "name": names[sid], "rounds_played": n, "kills": k,
            "deaths": sum(r["deaths"] for r in rows), "assists": sum(r["assists"] for r in rows),
            "flash_assists": 0, "headshot_kills": sum(1 for x in kills if x["attacker_steamid"] == sid and x["headshot"]
                                                      and x["attacker_side"] != x["victim_side"]),
            # 这些列留空，模拟「解析器没给」的情况：derive.py 会用自算值兜底
            "headshot_pct": None, "opening_kills": None, "opening_deaths": None,
            "traded_deaths": sum(r["traded"] for r in rows), "multikill_2k": None, "multikill_3k": None,
            "multikill_4k": None, "multikill_5k": None,
            "kast": round(100.0 * sum(r["kast"] for r in rows) / n, 2) if n else 0.0,
            "adr": round(sum(r["damage"] for r in rows) / n, 2) if n else 0.0,
            "clutches_played": None, "clutches_won": None, "clutch_1v1": 0, "clutch_1v2": 0, "clutch_1v3": 0,
            "clutch_1v4": 0, "clutch_1v5": 0, "utility_damage": None, "flashes_thrown": 0, "enemies_flashed": 0,
            "flash_duration_dealt": 0.0,
        })
    final_a_side = CT if played <= 12 else T
    players = [{"steamid": sid, "name": names[sid], "side": final_a_side if sid in team_a else
                (T if final_a_side == CT else CT), "team_clan_name": None} for sid in team_a + team_b]
    players.append({"steamid": "0", "name": "DemoRecorder", "side": None, "team_clan_name": None})

    playback_ticks = tick
    parsed = {
        "meta": {"map_name": map_name, "server_name": f"Synthetic #{seed}", "client_name": "GOTV",
                 "demo_version_name": "valve_demo_2", "build_num": 10500, "playback_ticks": playback_ticks,
                 "playback_time": playback_ticks / TICK_RATE, "tick_rate": float(TICK_RATE)},
        "header": {"map_name": map_name, "build_num": 10500},
        "datasets": {
            "rounds": rounds, "kills": kills, "damages": damages, "shots": shots, "stats": stats,
            "players": players, "round_economy": economy, "item_events": items, "bomb": [], "blinds": [],
            "chat": [], "grenades": [], "fires": [], "smokes": [],
        },
        "timings": {}, "dataset_errors": {}, "parse_seconds": 1.0,
    }
    truth = {
        "score": dict(score), "team_a": team_a, "team_b": team_b, "rounds_played": played,
        "player_round": truth_pr, "knife_round": knife_round,
    }
    return parsed, truth


def _kill(attacker, victim, assister, side_of, names, weapon, headshot, tick, is_trade, rng) -> dict:
    row = {"tick": tick, "weapon": weapon, "headshot": headshot, "dominated": False, "revenge": False,
           "noscope": weapon == "awp" and rng.random() < 0.1, "penetrated": rng.random() < 0.05,
           "thrusmoke": rng.random() < 0.05, "hitgroup": 1 if headshot else 2,
           "hitgroup_name": "head" if headshot else "chest", "is_trade": is_trade, "victim_traded": False}
    for who, sid in (("attacker", attacker), ("victim", victim), ("assister", assister)):
        row[f"{who}_entity_id"] = 1 if sid else None
        row[f"{who}_entity_serial"] = 1 if sid else None
        row[f"{who}_steamid"] = sid
        row[f"{who}_name"] = names.get(sid) if sid else None
        row[f"{who}_side"] = side_of.get(sid) if sid else None
        row[f"{who}_x"] = 100.0 if sid else None
        row[f"{who}_y"] = -200.0 if sid else None
        row[f"{who}_z"] = 0.0 if sid else None
    return row


def _damage(attacker, victim, side_of, names, weapon, amount, health_pre, tick) -> dict:
    return {"tick": tick, "weapon": weapon, "dmg_health": amount, "dmg_armor": 0, "hitgroup": 2,
            "hitgroup_name": "chest", "health_pre": health_pre, "health_post": max(0, health_pre - amount),
            "armor_pre": 100, "armor_post": 100,
            "attacker_steamid": attacker, "attacker_name": names[attacker], "attacker_side": side_of[attacker],
            "victim_steamid": victim, "victim_name": names[victim], "victim_side": side_of[victim],
            "attacker_x": 0.0, "attacker_y": 0.0, "attacker_z": 0.0, "victim_x": 0.0, "victim_y": 0.0, "victim_z": 0.0}


def library(n: int = 12, seed: int = 7) -> list[tuple[dict, dict]]:
    """一批「我」(steamid(1)) 参与的比赛：不同地图、不同队友、实力逐渐上升。"""
    rng = random.Random(seed)
    maps = ["de_mirage", "de_inferno", "de_ancient", "de_nuke", "de_dust2", "de_anubis"]
    out = []
    for i in range(n):
        parsed, truth = make_match(seed=seed * 100 + i, map_name=maps[i % len(maps)],
                                   hero_boost=0.2 + 0.08 * i, skill_b=0.9 + rng.random() * 0.3)
        out.append((parsed, truth))
    return out


def per_side_truth(truth: dict, sid: str) -> dict[str, dict]:
    agg: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    for (s, _r), row in truth["player_round"].items():
        if s != sid:
            continue
        b = agg[row["side"]]
        b["rounds"] += 1
        for k in ("kills", "deaths", "assists", "damage", "kast", "won"):
            b[k] += row[k]
    return {side: dict(v) for side, v in agg.items()}
