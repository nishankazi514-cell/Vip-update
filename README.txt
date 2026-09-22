HIGH CARD DUEL — BDXBET INTEGRATION
===================================

This build is a non-wagering 1v1 multiplayer card game.
It uses virtual points only. There are no deposits, stakes, cash-out, rake, or real-money features.

FILES
-----
app.py
requirements.txt
templates/index.html
static/style.css
static/main.js

LOCAL TEST
----------
1. pip install -r requirements.txt
2. python app.py
3. Open http://127.0.0.1:5000 in two separate browsers/devices.
4. Press FIND OPPONENT on both.

RENDER
------
Build Command: pip install -r requirements.txt
Start Command: python app.py
Root Directory: blank

The server reads Render's PORT automatically.

BDXBET EMBED
------------
The game is a standalone route that can be placed inside your existing site's Games area or loaded in an iframe.
The page has an exit button that sends a postMessage named BDXBET_EXIT_HIGH_CARD_DUEL when embedded.

GAME FLOW
---------
Game screen -> Find Opponent -> Match Found -> 3/2/1 -> cards reveal -> Win/Lose/Draw -> virtual points -> Play Again.

The server owns the deck and result calculation.
The browser only renders the server result and stores local virtual-points/history values.
