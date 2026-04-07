# Virtual Chart Navigation Trainer — Code Generation Plan

## Instructions for the LLM

Build this as a **single self-contained HTML file** with all CSS and JS inlined or bundled. It must run directly from the filesystem without a server, you may use which ever framework is best suited.

Work through the build order at the bottom of this document. Do not skip ahead — each step depends on the previous. After each step confirm the deliverable compiles and runs before moving to the next.

---

## Application Overview

A browser-based single-page application that generates a fictional but realistic nautical chart and provides virtualized replicas of the physical tools a navigator uses at the chart table. The goal is skill reinforcement through repetition — plotting courses, taking bearings, measuring distances, calculating ETA, and finding position — with immediate feedback against ground truth the app holds internally.

---

## The Chart

### Generation

The chart is procedurally generated so every session is different. It is not a real place, but it obeys real cartographic rules.

**What gets generated:**

- A coastline using layered Perlin/simplex noise, smoothed into a believable outline with headlands, bays, and a harbour entrance
- Depth soundings scattered across the water area, decreasing toward shore, with shoal patches and a main navigable channel
- Depth contour lines at 5m, 10m, 20m
- A set of named landmarks: lighthouse, church spire, radio mast, water tower — positioned on the coast and inland with consistent bearing geometry
- A compass rose (true and magnetic, with variation noted — e.g. 3°W)
- A latitude/longitude grid with tick marks along the borders
- A linear scale bar
- Named ports, anchorages, and a harbour with a buoyed channel
- Cardinal and lateral (IALA Region A) buoys marking the channel and hazards
- A title block: chart number, scale (e.g. 1:50,000), date, datum

**Rendering:**

SVG canvas. The chart is drawn as a real nautical chart: blue water, white/beige land, standard IALA symbols, soundings in metres. The SVG is large enough to require panning but fits within a single screen with zoom.

**Internal coordinate system:**

The chart has an internal coordinate system mapping to latitude/longitude (fictional). The grid lines correspond to real minutes-of-arc spacing. Store this mapping so tools can report real lat/lon values and distance can be measured correctly. Use a simple Mercator-like projection — straight grid lines, constant scale across the chart area.

Example internal bounds:
- Lat: 52°00'N to 52°30'N
- Lon: 004°00'W to 004°40'W
- Scale: 1:50,000

---

## Tools

Each tool is a draggable interactive overlay rendered on a Canvas layer above the SVG chart. Tools do not snap or auto-correct — the navigator must use them correctly.

---

### Tool 1: Parallel Rules

A pair of linked rules that transfer a bearing from the compass rose to a plotted line anywhere on the chart.

**Visual:** Two rectangular rules connected at two pivot points, rendered as slightly transparent dark bars with degree markings along the edge.

**Interaction:**
- Click and drag either rule to move the pair
- The two rules maintain a fixed parallel relationship
- A pivot/hinge between them allows the stepping motion: drag one rule while the other is held, then swap — this is the "walking" motion
- When the edge of a rule passes through the compass rose centre, the bearing reading is displayed as a tooltip
- The navigator can align the rule on the rose, then walk it to their intended position

**State to track:** position of each rule, angle of both rules (always equal), which rule is currently being stepped.

---

### Tool 2: Dividers

A two-legged instrument for measuring distances against the latitude scale.

**Visual:** Two lines meeting at a hinge point at the top, each ending in a point, forming a V shape. Rendered as thin dark lines with circular drag handles at the tips and hinge.

**Interaction:**
- Drag either tip independently
- The hinge point is draggable to move the whole instrument
- The span between tips is computed in chart units and converted to nautical miles using the latitude scale (1 minute of latitude = 1 NM)
- A readout shows the span in degrees/minutes and NM
- A "step" button or gesture allows accumulating distance over a multi-leg route with a running total shown in the workbook strip

**State to track:** position of each tip, accumulated distance total.

---

### Tool 3: Pencil / Line Plotter

A drawing tool that leaves persistent marks on the chart.

**Visual:** Lines are rendered as thin grey pencil-stroke-textured lines on the chart canvas.

**Interaction:**
- Click to set start point, click again to set end point and commit a straight line
- Shift+click for freehand
- Each line is labeled on creation with its type: Course Line, Bearing Line, Position Line, DR Track
- Any line that passes near a compass rose centre shows its bearing
- Individual lines can be selected and deleted
- "Clear all" removes all drawn lines

**State to track:** array of line objects, each with start, end, label, type, bearing if applicable.

---

### Tool 4: Hand Bearing Compass

Takes a bearing to a charted landmark.

**Visual:** A circular compass rose rendered as a draggable overlay that the navigator positions near the landmark they are observing.

**Interaction:**
- Click a charted landmark (lighthouse, spire, mast, water tower) to "take a bearing"
- The true bearing from the vessel's current position (or last DR position) to the landmark is computed internally
- A small random error is applied (±2°, gaussian) to simulate real instrument error
- The bearing is displayed as **magnetic** — the navigator must apply variation to get true
- Variation is shown in the workbook strip and on the chart title block
- The bearing is logged in the workbook strip
- Optionally the navigator can draw the reciprocal bearing as a position line using the pencil tool

**State to track:** last bearing taken, landmark clicked, true bearing (internal, not shown), magnetic bearing (shown).

---

### Tool 5: Portland Plotter / Protractor

A one-piece course plotter for reading a bearing directly from the chart grid without needing the compass rose.

**Visual:** A rectangular transparent protractor with a 360° degree ring and a straight edge along the baseline.

**Interaction:**
- Drag to position anywhere on the chart
- Rotate freely by dragging the degree ring
- The centre mark is placed over a known point
- The bearing of the straight edge is read against the chart's north grid lines directly
- Removes the need to walk parallel rules to the compass rose

**State to track:** position, rotation angle.

---

### Tool 6: Speed-Time-Distance Calculator

A virtual circular slide rule for the navigator's triangle: Speed × Time = Distance.

**Visual:** Three concentric rings labeled Speed (knots, outer), Time (hours and minutes, middle), Distance (NM, inner). Mimics the Nautical Slide Rule or Brookes & Gatehouse type calculator.

**Interaction:**
- Drag any ring to set a value; the remaining ring is computed automatically
- Alternatively: three numeric input fields for direct entry
- The computed value updates in real time
- Results are pushable to the workbook strip

**Formula:** `Distance = Speed × Time` where Time is in decimal hours.

**State to track:** speed, time, distance — any two set, one computed.

---

## Exercises

Exercises present a structured scenario with a known ground truth held internally. The navigator performs the task using the tools, submits their answer, and receives scored feedback. No hints are given during the exercise.

---

### Exercise 1: Dead Reckoning

**Given:** Last known position marked on chart, course steered (°T), speed (knots), elapsed time (hours and minutes).

**Task:** Plot the DR position and mark it with the standard DR symbol (semicircle).

**Ground truth:** Computed internally using the same course/speed/time values.

**Scoring:** Distance between the navigator's plotted position and true DR position, in nautical miles. Thresholds: <0.1 NM = excellent, <0.3 NM = good, >0.3 NM = retry.

---

### Exercise 2: Course to Steer

**Given:** Departure point and destination point both marked on the chart.

**Task:**
1. Use parallel rules (or plotter) to read the true course
2. Apply variation to get the magnetic course to steer
3. Enter the values in the workbook strip

**Ground truth:** True course computed from chart coordinates; magnetic = true ± variation (note: West variation is subtracted from true to get magnetic for most conventions — the navigator must know the rule).

**Scoring:** True course accuracy (±1° = pass), correct magnetic conversion, correct application of variation direction.

---

### Exercise 3: Fix by Cross Bearing

**Given:** Vessel is at an unknown position. Three named landmarks are visible. Bearings to each are provided (magnetic, with ±2° instrument error applied).

**Task:**
1. Convert each bearing from magnetic to true (apply variation)
2. Plot each as a position line (reciprocal bearing from the landmark)
3. The three lines form a triangle of error (cocked hat)
4. Mark the fix at the appropriate corner of the cocked hat (the corner nearest the danger)

**Ground truth:** True vessel position held internally; the three landmarks and bearings are computed from that position.

**Scoring:**
- Accuracy of each position line (±2° tolerance matching instrument error)
- Fix position accuracy in NM
- Correct identification of which corner to use when a hazard is present

---

### Exercise 4: Distance and ETA

**Given:** Two points on a plotted course line. A departure time. Vessel speed.

**Task:**
1. Measure the distance between the two points using the dividers and latitude scale
2. Use the S-T-D calculator to compute time underway
3. Add to departure time to get ETA
4. Enter ETA in the workbook strip

**Ground truth:** True distance computed from chart coordinates.

**Scoring:** Distance accuracy (±0.1 NM), time accuracy (±2 minutes), ETA accuracy (±2 minutes).

---

### Exercise 5: Clearing Bearing

**Given:** A headland with a charted hazard (shoal or rock) on one side of it.

**Task:**
1. Identify the safe side of the hazard
2. Draw a clearing bearing line using the parallel rules or plotter such that maintaining the bearing on the safe side keeps the vessel clear
3. State the clearing bearing value

**Ground truth:** The minimum bearing (or maximum, depending on geometry) that clears the hazard by at least one cable (0.1 NM).

**Scoring:** Whether the drawn clearing bearing actually clears the marked danger, correct bearing value (±2°), correct stated direction of safety (bearing greater than / less than).

---

### Exercise 6: Set and Drift

**Given:** Vessel departs known position, steers a known course at known speed for a known time. After that period, a fix shows the vessel is not at the DR position.

**Task:**
1. Plot the DR position from the departure point
2. Plot the fix position (given or taken by cross bearing)
3. Draw a vector from DR to fix — this is the set and drift
4. Measure the direction (set) and length (drift rate = distance ÷ time)

**Ground truth:** A current vector is held internally and was applied to produce the fix offset.

**Scoring:** Set direction accuracy (±5°), drift rate accuracy (±0.1 knot).

---

## Feedback System

After each exercise submission:

- The correct answer is overlaid on the chart in a contrasting colour (e.g., red for true answer, blue for navigator's answer)
- Error is stated in plain language: distance in NM for position errors, degrees for bearing errors
- A brief explanation of what went wrong if the score is below threshold
- No real-time hints during the exercise — the navigator must commit before seeing feedback

---

## UI Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  TOOLBAR                                                          │
│  [Parallel Rules] [Dividers] [Pencil] [Compass] [Plotter] [S-T-D]│
│  [Erase] [Clear All]                    [New Chart] [Exercise ▾] │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│                                                                   │
│                        CHART CANVAS                               │
│                     (pan + zoom)                                  │
│                                                                   │
│                  [ tool overlays rendered here ]                  │
│                                                                   │
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│  WORKBOOK STRIP                                                   │
│  Variation: 3°W  │  Last bearing: 047°T (050°M)  │  Dist: 4.2NM │
│  Course: 215°T   │  ETA: 14:32  │  DR Pos: 52°14.2N 004°22.1W   │
└──────────────────────────────────────────────────────────────────┘
```

The workbook strip mirrors the paper notepad kept alongside the chart. The navigator populates it as they work. Values from tools push into it automatically (e.g., bearing taken, distance measured). Editable fields allow manual entry.

---

## Technical Specification

### Stack

| Concern | Choice |
|---|---|
| Language | Vanilla ES2022 JS, no framework |
| Chart rendering | SVG (chart elements, landmarks, symbols) |
| Tool and draw layer | HTML Canvas (positioned over SVG, same dimensions) |
| Noise generation | Inline simplex noise implementation (no CDN) |
| Interaction | Pointer Events API (mouse + touch unified) |
| State | Module-level plain objects, no persistence |
| Build | Single `.html` file, all assets inlined |

### Coordinate System

Two coordinate spaces:

1. **Screen space** — pixels on the canvas element
2. **Chart space** — internal units mapping to lat/lon

Maintain a transform object `{ scale, offsetX, offsetY }` for pan/zoom. All tool positions are stored in chart space and projected to screen space for rendering. This means panning/zooming does not lose tool positions.

Lat/lon mapping:
- Define `chartBounds = { minLat, maxLat, minLon, maxLon }`
- `chartToScreen(lat, lon)` → `{ x, y }`
- `screenToChart(x, y)` → `{ lat, lon }`
- Distance: Haversine formula for accuracy, or flat-earth approximation is acceptable at this scale (±0.1% error over 30NM)

### File Structure (all inlined)

```
index.html
  <style>        — all CSS
  <body>
    #toolbar     — tool buttons and exercise picker
    #chart-wrap  — position:relative container
      #chart-svg — SVG chart layer
      #draw-canvas — Canvas tool/draw layer (same size, position:absolute over SVG)
    #workbook    — bottom strip
  <script>
    // simplex-noise inline
    // chartGen.js  — chart generation
    // tools.js     — tool implementations
    // exercises.js — exercise logic and scoring
    // app.js       — wiring and event handling
  </script>
```

---

## Chart Symbol Reference (for rendering)

Use simplified versions of standard IHO/IALA symbols:

| Feature | Symbol |
|---|---|
| Lighthouse | Magenta filled circle with rays |
| Church spire | Cross |
| Radio mast | Vertical line with crossbars |
| Water tower | Circle on stem |
| Wreck (dangerous) | `+` with circle |
| Shoal / rock awash | `*` or `+` |
| Port-hand buoy (IALA A) | Red can |
| Starboard-hand buoy (IALA A) | Green cone |
| Cardinal buoy (N) | Black over yellow, two upward cones |
| Depth sounding | Small italic number in blue |
| DR position | Half-circle on course line |
| Fix | Circle on course line |
| Compass rose | Full 360° true outer ring, magnetic inner ring |

---

## Build Order

Complete each step fully before starting the next. Each step should result in a working browser state.

1. **Scaffold** — Single HTML file, toolbar, chart container div, workbook strip, CSS layout
2. **Chart generator** — Coastline (noise), land fill, water fill, depth soundings, contour lines
3. **Landmarks and symbols** — Lighthouse, spire, mast, water tower, buoys, harbour
4. **Chart furniture** — Compass rose (true + magnetic + variation label), lat/lon grid, scale bar, title block
5. **Pan and zoom** — Mouse wheel zoom, click-drag pan, transform applied to both SVG and Canvas layers
6. **Pencil tool** — Draw straight lines, label them, store in chart space, re-render on pan/zoom
7. **Parallel rules** — Two-bar walking mechanism, bearing readout when aligned on rose
8. **Dividers** — Two-point instrument, distance readout against latitude scale, step accumulation
9. **Portland plotter** — Rotatable protractor overlay, bearing readout from grid north
10. **Hand bearing compass** — Click landmark → bearing (magnetic, ±2° error) → log to workbook
11. **S-T-D calculator** — Circular or field-based interface, speed/time/distance solving
12. **Exercise framework** — Ground truth engine, submission button, scoring function, feedback overlay
13. **Exercise set** — Implement all 6 exercises using the framework
14. **Polish** — Erase tool, clear all, new chart generation, exercise picker dropdown

---

## Notes for Code Generation

- Generate the coastline with a seeded RNG so `New Chart` produces a different chart but the same seed always produces the same chart. Expose the seed in the title block.
- The compass rose must be positioned in open water, not overlapping the coast or landmarks. Check after generation.
- Variation for the generated chart should be randomised per session in the range 2°W to 5°W (Western approaches flavour).
- Bearings are always stored internally as true (°T). Conversion to magnetic is always: magnetic = true + variation (West variation adds, East subtracts — using the traditional "Error West, Compass Best" rule from the navigator's perspective is unnecessary complexity; just use the formula consistently).
- The workbook strip bearing readout should always show both: `047°T (050°M)` given 3°W variation.
- When an exercise is active, the toolbar should disable tools not relevant to that exercise to reduce confusion.
- Touch support is required — use Pointer Events throughout, not mouse events.
