import pytest

from app.analysis import derive, highlights
from app.analysis.common import CT, T, RoundIndex, norm_side
from app.devtools import synth


@pytest.fixture(params=[1, 2, 3, 11])
def match(request):
    parsed, truth = synth.make_match(seed=request.param, knife_round=request.param == 2,
                                     teamkill_round=4 if request.param == 3 else None)
    return parsed, truth, derive.derive_match(parsed["datasets"])


def test_team_score_matches_truth(match):
    _parsed, truth, d = match
    assert d.teams["A"]["score"] == truth["score"]["A"]
    assert d.teams["B"]["score"] == truth["score"]["B"]
    assert d.teams["A"]["start_side"] == CT
    assert sorted(d.teams["A"]["members"]) == sorted(truth["team_a"])


def test_knife_round_excluded(match):
    _parsed, truth, d = match
    assert len(d.rounds) == truth["rounds_played"]
    assert all(r["round_num"] != 1 for r in d.rounds) if truth["knife_round"] else True


def test_per_round_side_inference_survives_halftime_noise(match):
    _parsed, truth, d = match
    for row in d.player_round:
        assert row["side"] == truth["player_round"][(row["steamid"], row["round_num"])]["side"]


@pytest.mark.parametrize("key", ["kills", "deaths", "assists", "damage", "kast", "won"])
def test_player_round_facts_match_truth(match, key):
    _parsed, truth, d = match
    for row in d.player_round:
        expected = truth["player_round"][(row["steamid"], row["round_num"])][key]
        assert row[key] == expected, (row["steamid"], row["round_num"], key)


def test_side_split_sums_back_to_match_totals(match):
    _parsed, truth, d = match
    for pm in d.player_match:
        rows = [r for r in d.player_round if r["steamid"] == pm["steamid"]]
        ct = derive.side_summary([r for r in rows if r["side"] == CT])
        t = derive.side_summary([r for r in rows if r["side"] == T])
        assert ct["rounds"] + t["rounds"] == pm["rounds_played"]
        assert ct["kills"] + t["kills"] == pm["kills"]
        # 自算 ADR 与「标准答案 stats」（扮演 awpy）一致
        assert pm["adr_calc"] == pytest.approx(pm["adr"], abs=0.01)
        assert pm["kast_calc"] == pytest.approx(pm["kast"], abs=0.01)
        truth_sides = synth.per_side_truth(truth, pm["steamid"])
        assert ct["kills"] == truth_sides.get(CT, {}).get("kills", 0)


def test_result_is_team_based_not_side_based(match):
    _parsed, truth, d = match
    a_won = truth["score"]["A"] > truth["score"]["B"]
    for pm in d.player_match:
        in_a = pm["steamid"] in truth["team_a"]
        expected = "T" if truth["score"]["A"] == truth["score"]["B"] else ("W" if in_a == a_won else "L")
        assert pm["result"] == expected


def test_teamkill_not_counted_as_kill():
    parsed, truth = synth.make_match(seed=3, teamkill_round=4)
    d = derive.derive_match(parsed["datasets"])
    tks = [k for k in d.kills if k["is_teamkill"]]
    assert tks, "合成数据应当包含一次友军击杀"
    for k in tks:
        row = next(r for r in d.player_round if r["steamid"] == k["attacker_steamid"] and r["round_num"] == k["round_num"])
        assert row["kills"] == truth["player_round"][(row["steamid"], row["round_num"])]["kills"]


def test_score_progression_and_round_rows():
    parsed, truth = synth.make_match(seed=5)
    d = derive.derive_match(parsed["datasets"])
    last = d.rounds[-1]
    assert (last["score_a"], last["score_b"]) == (truth["score"]["A"], truth["score"]["B"])
    assert all(r["team_a_side"] in (CT, T) for r in d.rounds)
    assert d.rounds[0]["ct_equipment"] is not None


def test_weapons_aggregate_kills():
    parsed, _truth = synth.make_match(seed=6)
    d = derive.derive_match(parsed["datasets"])
    for pm in d.player_match:
        total = sum(w["kills"] for w in d.player_weapon if w["steamid"] == pm["steamid"])
        assert total == pm["kills"]
    assert all(not w["weapon"].startswith("weapon_") for w in d.player_weapon)
    assert any(w["shots"] > 0 and w["hits"] > 0 for w in d.player_weapon)


def test_missing_datasets_degrade_gracefully():
    parsed, _ = synth.make_match(seed=8)
    ds = {"rounds": parsed["datasets"]["rounds"], "kills": parsed["datasets"]["kills"]}
    d = derive.derive_match(ds)
    assert d.player_match and d.player_round
    assert all(pm["stats_source"] == "derived" for pm in d.player_match)
    assert derive.derive_match({}).warnings


def test_highlights_are_sorted_and_windowed():
    parsed, _ = synth.make_match(seed=3)
    d = derive.derive_match(parsed["datasets"])
    hl = highlights.detect(d, 64)
    assert hl
    assert [h["score"] for h in hl] == sorted((h["score"] for h in hl), reverse=True)
    for h in hl:
        assert h["tick_start"] < min(h["key_ticks"]) <= max(h["key_ticks"]) < h["tick_end"]
        assert 0 < h["score"] <= 1


def test_round_index_and_side_aliases():
    idx = RoundIndex([{"round_num": 1, "start_tick": 0, "end_tick": 90, "official_end_tick": 100},
                      {"round_num": 2, "start_tick": 150, "end_tick": 300, "official_end_tick": None}])
    assert idx.round_of(95) == 1      # end_tick 之后、official_end_tick 之前仍属第 1 回合
    assert idx.round_of(120) is None  # 回合间隙
    assert idx.round_of(300) == 2
    assert idx.round_of(301) is None
    assert norm_side("CT") == CT and norm_side(2) == T and norm_side("spectator") is None
