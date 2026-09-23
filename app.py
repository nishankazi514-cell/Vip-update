import eventlet
eventlet.monkey_patch()

import math
import os
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from flask import Flask, render_template, request
from flask_socketio import SocketIO

# --------------------------------------------------------------------------
# Game settings
# --------------------------------------------------------------------------
ROUNDS_TO_WIN = 2
COUNTDOWN_FROM = 3
MIN_SIGNAL_DELAY = 2.0
MAX_SIGNAL_DELAY = 5.0
TAP_TIMEOUT = 3.0
MIN_HUMAN_MS = 80.0
MAX_REACTION_MS = 10_000.0
MATCH_INTRO_PAUSE = 2.0
RESULT_PAUSE = 2.8
FINAL_PAUSE = 1.8
NAME_MAX_LEN = 14

DEBUG = os.environ.get("DEBUG", "0") == "1"

def log(*a):
    if DEBUG:
        print("[STA]", *a, flush=True)

# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", uuid.uuid4().hex)

# Allow all origins by default — safest for local / ngrok / LAN play.
socketio = SocketIO(
    app,
    async_mode="eventlet",
    cors_allowed_origins="*",
    ping_interval=5,
    ping_timeout=10,
    logger=DEBUG,
    engineio_logger=DEBUG,
)

# --------------------------------------------------------------------------
# In-memory state
# --------------------------------------------------------------------------
@dataclass
class Match:
    id: str
    players: List[str]
    names: Dict[str, str]
    scores: Dict[str, int]
    round_no: int = 1
    state: str = "intro"
    token: int = 0
    signal_at: float = 0.0
    times: Dict[str, float] = field(default_factory=dict)
    history: List[dict] = field(default_factory=list)
    replay: bool = False

    def opponent(self, sid: str) -> str:
        return self.players[1] if sid == self.players[0] else self.players[0]


waiting_queue: List[str] = []
matches: Dict[str, Match] = {}
player_match: Dict[str, str] = {}
player_names: Dict[str, str] = {}
connected: set = set()


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def clean_name(raw) -> str:
    name = re.sub(r"[\x00-\x1f\x7f<>&\"'`]", "", str(raw or ""))
    name = re.sub(r"\s+", " ", name).strip()[:NAME_MAX_LEN].strip()
    return name or f"Player{random.randint(100, 999)}"


def parse_ms(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return round(min(float(value), MAX_REACTION_MS), 1)


def broadcast_stats() -> None:
    socketio.emit("stats", {
        "online": len(connected),
        "in_queue": len(waiting_queue),
        "live_matches": len(matches),
    })


def remove_from_queue(sid: str) -> bool:
    if sid in waiting_queue:
        waiting_queue.remove(sid)
        return True
    return False


def alive(m: Match, token: int) -> bool:
    return matches.get(m.id) is m and m.token == token and m.state != "finished"


def emit_match(m: Match, event: str, data: dict) -> None:
    """Emit reliably to both players — never rely solely on room broadcast."""
    for sid in list(m.players):
        if sid in connected:
            try:
                socketio.emit(event, data, to=sid)
            except Exception as e:
                log("emit failed", event, sid, e)


# --------------------------------------------------------------------------
# Matchmaking
# --------------------------------------------------------------------------
def try_matchmaking() -> None:
    while len(waiting_queue) >= 2:
        a = waiting_queue.pop(0)
        b = waiting_queue.pop(0)
        create_match(a, b)


def create_match(a: str, b: str) -> None:
    match_id = str(uuid.uuid4())
    m = Match(
        id=match_id,
        players=[a, b],
        names={a: player_names.get(a, "Player"), b: player_names.get(b, "Player")},
        scores={a: 0, b: 0},
    )
    matches[match_id] = m
    log("match created", match_id, m.names)

    for sid in (a, b):
        player_match[sid] = match_id
        try:
            socketio.server.enter_room(sid, match_id, namespace="/")
        except Exception as e:
            log("enter_room failed (non-fatal)", sid, e)
        socketio.emit("match_found", {
            "match_id": match_id,
            "you": m.names[sid],
            "opponent": m.names[m.opponent(sid)],
            "rounds_to_win": ROUNDS_TO_WIN,
        }, to=sid)

    socketio.start_background_task(run_round, m, m.token, MATCH_INTRO_PAUSE)
    broadcast_stats()


# --------------------------------------------------------------------------
# Round engine
# --------------------------------------------------------------------------
def run_round(m: Match, token: int, lead_in: float = 0.0) -> None:
    if lead_in:
        socketio.sleep(lead_in)
    if not alive(m, token):
        return

    m.state = "countdown"
    m.times.clear()
    log("round start", m.id, "r", m.round_no)

    for n in range(COUNTDOWN_FROM, 0, -1):
        emit_match(m, "countdown", {"count": n, "round": m.round_no, "replay": m.replay})
        socketio.sleep(1.0)
        if not alive(m, token):
            return

    m.state = "waiting"
    emit_match(m, "get_set", {"round": m.round_no})

    socketio.sleep(random.uniform(MIN_SIGNAL_DELAY, MAX_SIGNAL_DELAY))
    if not alive(m, token):
        return

    m.signal_at = time.monotonic()
    m.state = "signal"
    emit_match(m, "tap_now", {"round": m.round_no})
    log("signal fired", m.id)

    while (alive(m, token) and len(m.times) < 2
           and time.monotonic() - m.signal_at < TAP_TIMEOUT):
        socketio.sleep(0.02)

    if alive(m, token) and m.state == "signal":
        resolve_reaction_round(m)


def resolve_reaction_round(m: Match) -> None:
    a, b = m.players
    ta, tb = m.times.get(a), m.times.get(b)
    if ta is None and tb is None:
        finish_round(m, None, "no_response")
    elif tb is None:
        finish_round(m, a, "timeout")
    elif ta is None:
        finish_round(m, b, "timeout")
    elif ta == tb:
        finish_round(m, None, "tie")
    else:
        finish_round(m, a if ta < tb else b, "reaction")


def round_payload(m: Match, rec: dict, sid: str) -> dict:
    opp = m.opponent(sid)
    if rec["winner"] is None:
        outcome = "draw"
    else:
        outcome = "win" if rec["winner"] == sid else "lose"
    foul = None
    if rec["foul"] is not None:
        foul = "you" if rec["foul"] == sid else "opponent"
    return {
        "round": rec["round"],
        "outcome": outcome,
        "reason": rec["reason"],
        "foul": foul,
        "your_time": rec["times"].get(sid),
        "opp_time": rec["times"].get(opp),
    }


def finish_round(m: Match, winner, reason: str, foul=None) -> None:
    if m.state not in ("waiting", "signal"):
        return
    m.state = "round_over"
    m.token += 1

    if winner is not None:
        m.scores[winner] += 1

    rec = {"round": m.round_no, "winner": winner, "reason": reason,
           "foul": foul, "times": dict(m.times)}
    m.history.append(rec)

    match_over = winner is not None and m.scores[winner] >= ROUNDS_TO_WIN
    if match_over:
        m.state = "finished"

    for sid in m.players:
        opp = m.opponent(sid)
        payload = round_payload(m, rec, sid)
        payload["scores"] = {"you": m.scores[sid], "opponent": m.scores[opp]}
        payload["match_over"] = match_over
        socketio.emit("round_result", payload, to=sid)

    log("round done", m.id, "winner", winner, "reason", reason,
        "scores", m.scores, "over", match_over)

    if match_over:
        socketio.start_background_task(conclude_match, m)
        return

    if winner is not None:
        m.round_no += 1
        m.replay = False
    else:
        m.replay = True

    socketio.start_background_task(run_round, m, m.token, RESULT_PAUSE)


def final_payload(m: Match, sid: str, reason: str, result=None) -> dict:
    opp = m.opponent(sid)
    if result is None:
        result = "victory" if m.scores[sid] > m.scores[opp] else "defeat"
    return {
        "result": result,
        "reason": reason,
        "scores": {"you": m.scores[sid], "opponent": m.scores[opp]},
        "rounds": [round_payload(m, rec, sid) for rec in m.history],
    }


def conclude_match(m: Match) -> None:
    socketio.sleep(FINAL_PAUSE)
    if matches.get(m.id) is not m:
        return
    for sid in list(m.players):
        if sid in connected:
            socketio.emit("match_over", final_payload(m, sid, "score"), to=sid)
    destroy_match(m)


def destroy_match(m: Match) -> None:
    if matches.pop(m.id, None) is None:
        return
    m.state = "finished"
    m.token += 1
    for sid in list(m.players):
        player_match.pop(sid, None)
        try:
            socketio.server.leave_room(sid, m.id, namespace="/")
        except Exception:
            pass
    log("match destroyed", m.id)
    broadcast_stats()


def handle_departure(sid: str) -> None:
    match_id = player_match.get(sid)
    m = matches.get(match_id) if match_id else None
    if m is None:
        player_match.pop(sid, None)
        return
    if m.state == "finished":
        return
    opp = m.opponent(sid)
    m.state = "finished"
    m.token += 1
    if opp in connected:
        socketio.emit("match_over",
                      final_payload(m, opp, "opponent_left", result="victory"),
                      to=opp)
    destroy_match(m)


# --------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    return {"status": "ok", "online": len(connected),
            "queue": len(waiting_queue), "matches": len(matches)}


# --------------------------------------------------------------------------
# Socket events
# --------------------------------------------------------------------------
@socketio.on("connect")
def on_connect(*_args):
    connected.add(request.sid)
    log("connect", request.sid, "total", len(connected))
    broadcast_stats()


@socketio.on("disconnect")
def on_disconnect(*_args):
    sid = request.sid
    log("disconnect", sid)
    connected.discard(sid)
    remove_from_queue(sid)
    handle_departure(sid)
    player_names.pop(sid, None)
    broadcast_stats()


@socketio.on("find_match")
def on_find_match(data=None):
    sid = request.sid
    if sid in player_match or sid in waiting_queue:
        socketio.emit("error_message",
                      {"message": "You are already searching or in a match."},
                      to=sid)
        return
    raw_name = data.get("name") if isinstance(data, dict) else None
    player_names[sid] = clean_name(raw_name)
    waiting_queue.append(sid)
    socketio.emit("queue_joined", {}, to=sid)
    log("queued", sid, player_names[sid], "queue", len(waiting_queue))
    broadcast_stats()
    try_matchmaking()


@socketio.on("cancel_search")
def on_cancel_search(data=None):
    sid = request.sid
    if remove_from_queue(sid):
        socketio.emit("queue_left", {}, to=sid)
        broadcast_stats()


@socketio.on("leave_match")
def on_leave_match(data=None):
    handle_departure(request.sid)


@socketio.on("tap")
def on_tap(data=None):
    sid = request.sid
    mid = player_match.get(sid)
    m = matches.get(mid) if mid else None
    if m is None or not isinstance(data, dict):
        return
    if m.state not in ("waiting", "signal"):
        return

    early = data.get("early") is True
    if early or m.state == "waiting":
        finish_round(m, m.opponent(sid), "false_start", foul=sid)
        return

    if sid in m.times:
        return
    ms = parse_ms(data.get("reaction_ms"))
    if ms is None:
        return
    if ms < MIN_HUMAN_MS:
        finish_round(m, m.opponent(sid), "false_start", foul=sid)
        return

    m.times[sid] = ms
    log("tap", m.id, sid, ms)
    if len(m.times) == 2:
        resolve_reaction_round(m)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Speed Tap Arena → http://localhost:{port}  (DEBUG={DEBUG})")
    socketio.run(app, host="0.0.0.0", port=port, debug=False,
                 allow_unsafe_werkzeug=True)
