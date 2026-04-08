# ⚓ Sailing Navigation Tool

**🌊 [Try the Live Demo!](https://tofudeadeye.github.io/sailing-nav-tool/)**

A browser-based maritime navigation trainer. Practice real chart work on a procedurally generated nautical chart covering a coastal area off **52°N, ~4°W**. No sailing experience required — just curiosity and a sense of adventure! 🧭

## 🗺️ What it does

The app generates a randomised nautical chart complete with depth soundings, contour lines, shoals, harbour entrances, channel buoys, cardinal buoys, landmarks (lighthouses, churches, masts, towers), and a compass rose. You then work through navigation exercises using the same tools you'd use on a real paper chart.

No GPS. No autopilot. Just you, the chart, and your wits. 🏴‍☠️

## 🛠️ Navigation tools

| Tool | Description |
|---|---|
| ✏️ **Pencil** | Draw and label lines on the chart (course, bearing, position, DR track) |
| 📐 **Dividers** | Measure distances in nautical miles |
| 🧭 **Plotter** | Plot and read true/magnetic bearings |
| 📏 **Parallel Rules** | Transfer bearings across the chart |
| 🔭 **Hand Bearing Compass** | Take bearings from landmarks to fix your position |
| ⏱️ **STD Panel** | Speed–Time–Distance calculator |

## 📋 Exercises

Six exercise types, each with auto-generated parameters and scored submission — see how well you do! 🏆

1. 🔵 **Dead Reckoning** — plot a DR position from a departure point, course, speed, and time
2. 🧲 **Course to Steer** — find the magnetic course between two charted points
3. ✖️ **Cross Bearing Fix** — take bearings from two landmarks to fix your position, checking for nearby hazards
4. ⏩ **Distance & ETA** — measure a route leg and calculate arrival time from speed
5. 🚧 **Clearing Bearing** — determine a safe clearing bearing to keep clear of a shoal
6. 🌊 **Set & Drift** — find the tidal vector from a DR position and an observed fix

Each exercise shows a brief instruction panel, restricts the toolset to what's needed, and gives pass/fail feedback with correct values overlaid on the chart. ✅

## 🌐 Chart generation

Charts are seeded — enter any integer to reproduce a specific chart! 🎲 The coordinate system uses an equirectangular projection calibrated so that SVG angles equal true geodetic bearings, making plotter and parallel-rule measurements accurate.

## ⚙️ Tech

Plain TypeScript, no frameworks. Canvas overlay for drawn lines and tool overlays, SVG layer for the chart itself. Deployed as a static site via GitHub Pages. Lightweight and fast! 🚀

## 🧑‍💻 Development

```bash
npm install
npm run dev   # local dev server
npm run build # production build
```
