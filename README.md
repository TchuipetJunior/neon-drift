# Neon Drift

A synthwave hover-car racer in the browser. Three.js + TypeScript + Vite, fully procedural: no image, model or audio assets.

**Play:** https://neon-drift-theta-three.vercel.app

## Features

- **Garage**: before every race, pick your car on a 3D turntable. Orbit, zoom and pan freely or jump to preset views (3/4, front, side, rear, top, low)
- **Three cars**: Neon Wedge (light, agile), the stainless-gray Tesla Cybertruck (higher top speed, heavier, shoves rivals aside) or the Mercedes Vision AVTR (best grip; rear flaps close under power and open on the brakes to show red)
- **Two tracks**: Sunset Strip (flowing curves) and Downtown (tight street circuit with a chicane), each with its own city and palette
- **Race** against 5 AI rivals on Easy / Normal / Insane, or **Time Trial** solo against your best-lap ghost
- **Drift to boost**: hold drift to charge 3 boost tiers, release to fire
- **Drift score**: drifts bank style points; chaining drifts within 2.5 s multiplies up to ×5, hitting a wall mid-drift is a wipeout
- **Medals** per track: Bronze / Silver / Gold / Neon lap targets
- **Challenge links**: share your best lap; the link carries your ghost so a friend races your exact run
- **Driver view**: switch between the chase cam and a first-person cockpit with a live dash screen and a wheel that turns with you
- Boost pads, live position, minimap, synthesized engine/drift/boost audio and soundtrack
- Keyboard, gamepad (Xbox/PlayStation) and touch controls (auto-throttle on phones)

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Accelerate | W / ↑ | RT | automatic |
| Brake / reverse | S / ↓ | LT | BRAKE |
| Steer | A D / ← → | Left stick | ◀ ▶ |
| Drift (hold) | Space / Shift | X / B / RB | DRIFT |
| Start / confirm | Enter | A / Start | tap |
| Driver / chase camera | C | LB | 👁 |
| Restart | R | Y | ↻ |
| Menu | Esc | Back | ✕ |
| Garage: change car / view | ← → / ↑ ↓ | D-pad | ◀ ▶ / view buttons |
| Garage: orbit camera | mouse drag, wheel zoom, right-drag pan | right stick | drag, pinch |
| Mute | M | | ♪ |

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
npx vercel --prod  # deploy
```

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run typecheck` and `npm run build` to make sure everything compiles. For larger changes, open an issue first so we can talk through the idea.

## License

[MIT](LICENSE) © Njotu Awasi

## Credits

3D models (all from Sketchfab, bundled with their `license.txt` in `public/models/`):

- This work is based on "2020 | Mercedes AVTR Concept | Thanks 100k wiew" (https://sketchfab.com/3d-models/2020-mercedes-avtr-concept-thanks-100k-wiew-690b13f974254b16a1c8ea8d6b92275b) by kevin (ケビン) (https://sketchfab.com/sohyalebret) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- This work is based on "Fortnite: Cybertruck" (https://sketchfab.com/3d-models/fortnite-cybertruck-47d11b3a7c0848d3b0c43fc085a5438d) by fred346b (https://sketchfab.com/fred346b) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- This work is based on "Sci-fi Buildings Pack (low-poly, game ready)" (https://sketchfab.com/3d-models/sci-fi-buildings-pack-low-poly-game-ready-333a430644b34e688aecfdc874f4cbf2) by TampaJoey (https://sketchfab.com/TampaJoey) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- This work is based on "Car Garage | Desert Garage Environment" (https://sketchfab.com/3d-models/car-garage-desert-garage-environment-ef8bb81713814d688487a81ae2467a51) by DevPoly3D (https://sketchfab.com/DevPoly3D) licensed under CC-BY-NC-4.0 (http://creativecommons.org/licenses/by-nc/4.0/) — **non-commercial use only**.

The AVTR's rear scale pods and the Cybertruck's wheels are baked into their meshes, so the game overlays animated lids / splits the wheels at load. All models are restyled (tints, neon emissives) to match the game.
