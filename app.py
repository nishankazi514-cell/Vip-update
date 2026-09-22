from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room
import os
import random
import threading
import uuid

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "high-card-duel-demo-secret")

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
)

RANKS = [
    ("2", 2), ("3", 3), ("4", 4), ("5", 5),
    ("6", 6), ("7", 7), ("8", 8), ("9", 9),
    ("10", 10), ("J", 11), ("Q", 12), ("K", 13), ("A", 14),
]

SUITS = [
    ("♠", "black"),
    ("♥", "red"),
    ("♦", "red"),
    ("♣", "black"),
]

waiting_players = []
rooms = {}
player_room = {}
state_lock = threading.RLock()


def create_deck():
    deck = []
    for rank, value in RANKS:
        for suit, color in SUITS:
            deck.append({
                "rank": rank,
                "value": value,
                "suit": suit,
                "color": color,
            })
    random.SystemRandom().shuffle(deck)
    return deck


def public_card(card):
    if not card:
        return None
    return {
        "rank": card["rank"],
        "suit": card["suit"],
        "color": card["color"],
    }


def remove_from_waiting(sid):
    with state_lock:
        waiting_players[:] = [p for p in waiting_players if p != sid]


def room_for(sid):
    with state_lock:
        room_id = player_room.get(sid)
        return room_id, rooms.get(room_id)


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    emit("connected", {"player_id": request.sid})


@socketio.on("find_match")
def handle_find_match():
    sid = request.sid

    with state_lock:
        existing_room = player_room.get(sid)
        if existing_room and existing_room in rooms:
            room = rooms[existing_room]
            emit("match_found", {
                "room": existing_room,
                "player_number": room["numbers"][sid],
            })
            return

        if sid in waiting_players:
            emit("matchmaking", {
                "status": "waiting",
                "message": "Searching for another player...",
            })
            return

        # Remove dead/stale candidates that no longer have a Socket.IO session.
        candidates = list(waiting_players)
        opponent = None
        while candidates:
            candidate = candidates.pop(0)
            if candidate != sid:
                opponent = candidate
                break

        waiting_players[:] = [p for p in waiting_players if p not in (opponent, sid)]

        if opponent is None:
            waiting_players.append(sid)
            emit("matchmaking", {
                "status": "waiting",
                "message": "Searching for another player...",
            })
            return

        room_id = str(uuid.uuid4())
        players = [opponent, sid]
        numbers = {opponent: 1, sid: 2}

        rooms[room_id] = {
            "players": players,
            "numbers": numbers,
            "deck": create_deck(),
            "cards": {},
            "finished": False,
            "started": False,
        }
        player_room[opponent] = room_id
        player_room[sid] = room_id

    join_room(room_id, sid=opponent)
    join_room(room_id, sid=sid)

    for player_sid in players:
        emit("match_found", {
            "room": room_id,
            "player_number": numbers[player_sid],
            "opponent_number": 1 if numbers[player_sid] == 2 else 2,
        }, to=player_sid)

    socketio.start_background_task(start_round, room_id)


@socketio.on("leave_match")
def handle_leave_match():
    leave_player(request.sid, notify=True)


@socketio.on("cancel_search")
def handle_cancel_search():
    remove_from_waiting(request.sid)
    emit("search_cancelled")


def start_round(room_id):
    socketio.sleep(1.0)

    with state_lock:
        room = rooms.get(room_id)
        if not room or len(room["players"]) != 2 or room["finished"]:
            return
        room["started"] = True
        players = list(room["players"])

    for sid in players:
        emit("round_start", {
            "countdown": 3,
            "round": 1,
        }, to=sid)

    socketio.sleep(3.0)

    with state_lock:
        room = rooms.get(room_id)
        if not room or room["finished"] or len(room["players"]) != 2:
            return

        if room["cards"]:
            return

        if len(room["deck"]) < 2:
            room["deck"] = create_deck()

        room["cards"] = {
            room["players"][0]: room["deck"].pop(),
            room["players"][1]: room["deck"].pop(),
        }
        players = list(room["players"])

    for sid in players:
        emit("reveal_card", {
            "card": public_card(room["cards"][sid]),
        }, to=sid)

    socketio.sleep(1.1)
    finish_round(room_id)


def finish_round(room_id):
    with state_lock:
        room = rooms.get(room_id)
        if not room or room["finished"] or len(room["players"]) != 2:
            return

        a, b = room["players"]
        card_a = room["cards"].get(a)
        card_b = room["cards"].get(b)
        if not card_a or not card_b:
            return

        room["finished"] = True

        if card_a["value"] > card_b["value"]:
            winner = a
        elif card_b["value"] > card_a["value"]:
            winner = b
        else:
            winner = None

        payloads = []
        for sid in (a, b):
            other = b if sid == a else a
            if winner is None:
                result = "draw"
            elif winner == sid:
                result = "win"
            else:
                result = "loss"

            payloads.append((sid, {
                "result": result,
                "round": 1,
                "your_card": public_card(room["cards"][sid]),
                "opponent_card": public_card(room["cards"][other]),
            }))

    for sid, payload in payloads:
        emit("round_result", payload, to=sid)

    socketio.start_background_task(cleanup_room, room_id, 7.0)


def cleanup_room(room_id, delay=5.0):
    socketio.sleep(delay)
    with state_lock:
        room = rooms.pop(room_id, None)
        if room:
            for sid in room["players"]:
                if player_room.get(sid) == room_id:
                    player_room.pop(sid, None)


def leave_player(sid, notify=True):
    remove_from_waiting(sid)

    with state_lock:
        room_id = player_room.get(sid)
        room = rooms.get(room_id) if room_id else None

        if not room:
            player_room.pop(sid, None)
            return

        others = [p for p in room["players"] if p != sid]
        rooms.pop(room_id, None)
        player_room.pop(sid, None)
        for other in others:
            if player_room.get(other) == room_id:
                player_room.pop(other, None)

    if notify:
        for other in others:
            emit("opponent_left", {
                "message": "Your opponent left the duel.",
            }, to=other)


@socketio.on("disconnect")
def handle_disconnect():
    leave_player(request.sid, notify=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
