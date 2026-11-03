# Glamis game

![Glamis game screenshot](docs/images/screenshot.png)

**Drive 1200 hp sandrails across the real dunes of Glamis (Imperial Sand Dunes, California) in your browser.**

Glamis game is a free, open source, multiplayer dune-driving game built with [three.js](https://threejs.org) (WebGL2) and a small Node.js server. The map is a 16 x 16 km piece of the real Imperial Sand Dunes around Gecko Road and Highway 78, built from USGS elevation data, with a 98 x 98 km horizon out to the Chocolate Mountains and the Salton Sea basin. On top of the real terrain the GPU grows procedural wind-shaped dunes: crests, slip faces, bowls and ripples. The physics run on the same math, so you drive on exactly what you see.

- **Real Glamis:** teleport to Competition Hill, Oldsmobile Hill, Brawley Slide, China Wall, The Wall, Dogleg bowl, Filler's Hole, Osborne Overlook, Glamis Flats and Gecko Loop.
- **Sandrail physics at 1000 Hz:** 1200 hp V8, torque converter and 3-speed gearbox (auto or manual), spool rear end, long-travel suspension with bump stops, paddle tires that dig in, wheelies, roll-overs and loops with wheelie control off.
- **Living sand:** every tire leaves ruts, paddle prints and berms that every car feels. Tracks are saved by the server and last 48 hours, so friends drive over your old lines.
- **Ten sandrails** with suspension, steering and drivetrain that move with the physics, and a full cockpit view with live dash, GPS map and mirrors in the GLX pro.
- **Weather and time:** clear to sandstorm, wind that drifts sand and dust, time of day, and night mode with a moonlit, starry sky, LED light bars and whip lights.
- **Multiplayer and computer riders:** play with friends on your network or over the internet, and add up to 12 computer-driven sandrails.
- **Plays with keyboard, mouse or a game controller**, and every control can be rebound.

## Play in your browser

**[Play Glamis game now](https://iotdatabase.github.io/glamis_game/)**, with nothing to install. You need a desktop browser with WebGL2 (Chrome or Edge work best). The first load downloads about 150 MB of terrain and car files, and your browser keeps a copy after that.

The browser version is single player: everything works except multiplayer and tire tracks that are saved for 48 hours, which need the game server. To play with friends, run the game yourself as shown below.

## Quick start

You need [Node.js](https://nodejs.org) (the LTS version) and a desktop browser with WebGL2. Chrome or Edge give the best performance.

### Windows

1. Install **Node.js LTS** from https://nodejs.org (one time only).
2. Download or clone this repository.
3. Double-click **`START-GAME.bat`**. A server window opens and your browser opens the game at http://localhost:8080. Leave the server window open while you play.

The first start installs the one server package it needs (`ws`) with npm, so it needs an internet connection that one time.

### Any system (Windows, macOS, Linux)

```bash
git clone https://github.com/iotdatabase/glamis_game.git
```

```bash
cd glamis_game
```

```bash
npm install
```

```bash
node server.js 8080
```

Then open **http://localhost:8080** in your browser. `npm start` does the same as the last command, and `./start.sh` starts the server and opens the browser on macOS and Linux. Use another number instead of `8080` to run on a different port.

Click once in the game window to turn on the engine sound.

### Playing with friends

Everyone connects to the computer that runs the server.

- **Same house / LAN:** the server window prints an address like `http://192.168.x.x:8080`. Friends open that in their browser. Windows may ask to let Node.js through the firewall: click Allow.
- **Over the internet:** forward TCP port 8080 on your router to the server PC and give friends `http://YOUR-PUBLIC-IP:8080`, or use a tunnel such as Tailscale or ngrok.

Press **P** in game to set your driver name. Each player gets a different paint colour.

## Controls

Every control can be changed in **M menu > Key bindings**: each action has two keyboard keys and two controller buttons. Click a box and press the new key or button (Backspace clears it, Esc cancels). Your layout is saved in your browser. **M**, **Esc** and the controller's **Start** button always open the menu. The tables show the defaults.

### Keyboard and mouse

| Action | Keys |
| --- | --- |
| Throttle | `W` or `↑` |
| Brake / reverse (hold when stopped) | `S` or `↓` |
| Steer left / right | `A` / `D` or `←` / `→` |
| Handbrake | `Space` |
| Shift down / up (in automatic the gearbox takes over again after 3 s; full manual in M > Controls) | `Q` / `E` |
| Change camera (chase, far, cockpit, hood, side) | `C` |
| Flip back upright | `R` |
| Light bars and whip lights on / off | `N` |
| Next teleport spot | `L` |
| Wheelie control on / off | `V` |
| Countersteer assist on / off | `G` |
| Time of day (past 7 PM it turns to night) | `T` |
| Hide HUD | `H` |
| Hide help panel | `F1` or `/` |
| Driver name | `P` |
| Record a video on / off (saved to Downloads) | `K` or `F8` |
| Menu | `M` or `Esc` |
| Look around | Drag the mouse |
| Zoom the camera | Mouse wheel |

### Recording videos

Press **K** (or **F8**) to start recording and press it again to stop. You can also use **M menu > Controls > Start / stop recording**, or click the red **REC** timer at the top of the screen. The video is saved to your browser's Downloads folder as `glamis-YYYYMMDD-HHMMSS.mp4` (or `.webm` in browsers that cannot record MP4). It records the 3D view at full resolution with the engine sound, without the HUD, radar or help panel, so the footage is clean. This works in the browser version too.

### Game controller (Xbox / PlayStation)

| Action | Button |
| --- | --- |
| Throttle | RT / R2 |
| Brake / reverse | LT / L2 |
| Steer | Left stick or D-pad left / right |
| Handbrake | B / Circle or A / Cross |
| Shift down / up | LB / L1 and RB / R1 |
| Change camera | Y / Triangle |
| Flip back upright | Back / Share |
| Light bars on / off | D-pad up |
| Next teleport spot | D-pad down |
| Look around | Right stick |
| Menu | Start / Options |

## Options and settings (press M)

All settings are remembered in your browser. Settings marked **shared** are the same for everyone online: when anyone changes one, every player's game follows, a message says who changed it, and players who join later get the current value. Everything else (car, graphics, sound, camera, radar) stays your own.

### Controls

| Setting | Choices |
| --- | --- |
| Gearbox | Automatic (default; `Q` / `E` shift for 3 s), Manual (`Q` / `E`, an M shows next to the gear) |
| Wheelie control (shared) | On, Off (full send: you can loop it) |
| Countersteer assist (shared) | On, Off |
| Steering speed | 50 to 180 % |
| Camera | Chase, Far, Cockpit, Hood, Side |
| Cockpit field of view | 60 to 90° vertical (default 78°) |
| Invert look up/down | Off, On |
| Sound volume | 0 to 100 % |

### Key bindings

Two keyboard keys and two controller inputs for each of the 18 actions in the tables above, plus **Reset all to defaults**.

### Quality

| Setting | Choices |
| --- | --- |
| Graphics preset | Ultra (tuned for an RTX 5090), High, Low. Changes terrain detail, shadow maps, tire-track resolution and particle counts; reloads the game |
| Render resolution | 50 to 200 % (above 100 % supersamples) |
| Shadows | Off, Low, High, Ultra |
| Photo sand textures | Off, Test patch at start, Everywhere |
| Live mirrors (cockpit) | On, Off (off gives more fps in the cockpit) |
| Driver arms (cockpit) | Show, Hide |
| Sand and dust amount | 25 to 200 % |

### Weather (all shared)

| Setting | Choices |
| --- | --- |
| Weather | Clear, Hazy, Partly cloudy, Overcast, Windy, Sandstorm |
| Night mode | Off, On (moonlight; `N` for light bars) |
| Time of day | 6:12 AM to 7:24 PM |
| Wind strength | 0 to 200 % |

### Teleport

| Group | Spots |
| --- | --- |
| Hill climbs (start at the bottom facing up) | Competition Hill, Oldsmobile Hill, Brawley Slide, Lizard Hill, China Wall, The Wall |
| Bowls | Dogleg, Filler's Hole |
| Camps and start | Osborne Overlook, Glamis Flats, Gecko Loop, Start bowl |

Places come from the BLM landmark list. Computer sandrails come along with you.

### Game

| Setting | Choices |
| --- | --- |
| Gravity (shared) | 1 to 20 m/s² in 0.01 steps, with Moon, Mars, Earth and 1.5 g buttons |
| Sand softness (shared) | 40 to 200 % (how deep tires sink) |
| Sand grip (shared) | 50 to 150 % |
| Your sandrail | GLX pro, GLX pro 2, Flame rail, Black, Blue, Green, Silver, Yellow, Trax, Classic (built in) |
| Computer sandrails (shared) | 0 to 12 |
| Computer driving (shared) | Cruising, Normal, Aggressive |
| Radar | On, Off |
| Radar in the cockpit | Screen corner, Dash screen only |
| Radar range | 300 m, 600 m, 1.2 km, 2.5 km |
| Name tags | On, Off |
| Help panel | On, Off |

### Address bar options

Add these to the game's address, for example `http://localhost:8080/?q=high&ss=1.5`:

| Option | Effect |
| --- | --- |
| `q=ultra`, `q=high`, `q=low` | Graphics preset for this visit |
| `ss=1.5` | Render scale (supersampling) |
| `tod=15` | Start at this hour of the day |
| `tm=agx` or `tm=neutral` | Tone mapping (default ACES) |
| `exp=0.6` | Exposure |

## Cars

Pick your car in **M menu > Game > Your sandrail**. Each model gets physics built from its own wheel positions and tire sizes, and its wheels, A-arms, tie rods, half shafts, coilovers and steering wheel move with the suspension. The computer sandrails drive the other models.

- **GLX pro** (default): carbon body with a black, grey and orange livery, twin-turbo V8, long-travel suspension, and a full cockpit with live race dash, DuneNav GPS map and mirrors. Built by the Python scripts in `blender/trx_pro/`.
- **GLX pro 2**: an earlier build of the GLX pro, kept for side-by-side comparison.
- **Flame rail** (red), **Black**, **Blue**, **Green**, **Silver** and **Yellow**: classic long-travel rails with flame paint.
- **Trax** (green): a race rail with a green livery.
- **Classic**: built in code (`public/js/sandrail-model.js`), no model file needed.

All the car models were made by the author of the game. To add your own car, put its `.glb` (and a `sandcar.physics.json` for the `sandcar` rig) in a new folder under `assets/`, add one line to the `CARS` list at the top of `public/js/gltf-sandrail.js` and add it to the `car` choices in `public/js/menu.js`.

## How it is built

| Path | What it is |
| --- | --- |
| `START-GAME.bat`, `start.sh` | Start the server and open the browser (Windows / macOS, Linux) |
| `server.js` | Web server, multiplayer relay (WebSocket) and 48-hour tire-track store |
| `public/` | The game: `index.html`, `js/` (game code), `vendor/` (three.js r186) |
| `public/data/` | Glamis elevation data (`height_fine.u16`, `height_coarse.u16`, `terrain.json`) |
| `assets/` | Car models (`.glb` + physics), driver arms, engine sound, sand textures |
| `blender/trx_pro/` | Python scripts and painted textures that rebuild the GLX pro in Blender (see its README) |
| `tools/` | Headless physics tests (`ruttest.mjs`, `stucktest.mjs`); they need `npm install three` first |
| `track-data/` | Saved tire tracks, created by the server when you play (not in git; delete it for fresh sand) |

Some highlights in the code:

- `public/js/terrain-render.js` and `terrain-data.js`: GPU dune generation (`duneHD`) and the matching physics (`dune()`); dune sizes are in `DUNE`.
- `public/js/vehicle-physics.js`: the sandrail simulation.
- `public/js/deform.js`, `sand-tracks.js`, `track-log.js`: tire ruts and their sharing.
- `public/js/ai-driver.js`: the computer riders.
- `public/js/menu.js` and `controls.js`: settings and key bindings.

## Contributing

This game is open to everyone, and help is very welcome! Some ideas: new cars and liveries, better sand and dust, sound, more Glamis landmarks, races and game modes, performance on slower PCs, mobile and touch controls, bug fixes.

1. **Fork** the repository and create a branch for your change.
2. Run the game locally (see Quick start) and check your change in the browser.
3. Open a **pull request** describing what you changed and why. Screenshots help.

Found a bug or have an idea? **Open an issue.** Questions, suggestions and feedback are all welcome.

## Licence

**This game is released into the public domain** under the [Unlicense](UNLICENSE). You can copy, change, share, sell or use it in any way you like, for any purpose, with no need to ask or give credit.

That covers the code, the car models, the driver's arms and the engine sound recordings, which were all made or recorded by the author. Every brand name and logo you see on the cars and in the cockpit (GLX, DRV, DCX Dune Comms, Sandline, DuneNav, Glamis Tire Co and so on) is made up for this game.

A few bundled third-party pieces keep their own licences, all of which allow free use:

| Part | Source | Licence |
| --- | --- | --- |
| three.js r186 and addons (`public/vendor/`) | [three.js](https://github.com/mrdoob/three.js) | MIT (licence header kept in each file) |
| `ws` (installed by `npm install`) | [websockets/ws](https://github.com/websockets/ws) | MIT |
| Sand textures (`assets/textures/`) | [Poly Haven](https://polyhaven.com): Sand 03, Aerial Beach 01 by Rob Tuytel | CC0 (public domain) |
| Elevation data (`public/data/`) | USGS 3DEP, via the AWS Terrain Tiles open dataset | US public domain |
| Landmark positions (`public/js/places.js`) | Bureau of Land Management landmark list | US public domain (facts) |
