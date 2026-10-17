from app.analysis import metrics

ROUNDS = [
    {"round_num": 1, "start_tick": 0, "end_tick": 900, "official_end_tick": 1000},
    {"round_num": 2, "start_tick": 1100, "end_tick": 2000, "official_end_tick": None},
]


def kill(tick, atk, vic, a_side="terrorist", v_side="counter-terrorist"):
    return {"tick": tick, "attacker_steamid": atk, "victim_steamid": vic, "attacker_side": a_side, "victim_side": v_side}


def test_rating_formula_and_guard():
    assert metrics.approximate_rating({"rounds_played": 0}) is None
    avg = metrics.approximate_rating({"rounds_played": 20, "kills": 14, "deaths": 14, "assists": 4, "kast": 70, "adr": 75})
    assert 0.9 < avg < 1.1


def test_multikills_counts_and_excludes_teamkills():
    kills = [kill(10, "a", "x1"), kill(20, "a", "x2"), kill(950, "a", "x3"),   # 950 在 end_tick 之后仍算第 1 回合
             kill(30, "a", "mate", v_side="terrorist"),                         # 友军击杀不计
             kill(1200, "b", "y1"), kill(1300, "b", "y2"), kill(1400, "b", "y3"), kill(1500, "b", "y4"), kill(1600, "b", "y5"),
             kill(1050, "a", "gap")]                                            # 回合间隙不计
    result = metrics.multikills(kills, ROUNDS)
    assert result["a"]["3k"] == 1 and result["a"]["2k"] == 0
    assert result["b"]["5k"] == 1 and result["b"]["ace"] == 1


def test_match_score_is_by_side():
    assert metrics.match_score([{"winner_side": "CT"}, {"winner_side": "terrorist"}, {"winner_side": None}]) == \
        {"terrorist": 1, "counter-terrorist": 1}


def test_heatmap_points_skip_missing_coords():
    rows = [{"attacker_x": 1, "attacker_y": 2, "weapon": "ak47", "tick": 5}, {"attacker_x": None, "attacker_y": 2}]
    assert len(metrics.heatmap_points(rows, "kills")) == 1
