# signalk-gps-heading

A [Signal K](https://signalk.org/) plugin that computes vessel true heading and midpoint position from two GPS antennas mounted port and starboard.

## How it works

The plugin subscribes to `navigation.position` updates from two configurable GPS sources. On each update it:

1. Computes the geodetic bearing between the port and starboard antennas.
2. Subtracts the known vessel-frame angle of the antenna baseline (derived from your mount dimensions) to recover true heading.
3. Applies an optional constant trim to absorb residual mounting error.
4. Smooths the result with a circular EWMA filter to reduce GPS noise.
5. Publishes the antenna midpoint as `navigation.position` and the smoothed heading as `navigation.headingTrue`.

## Installation

Install via the Signal K app store or manually:

```
npm install signalk-gps-heading
```

Then restart the Signal K server and enable the plugin under **Server → Plugin Config**.

## Configuration

| Field | Description | Default |
|---|---|---|
| Port antenna `$source` | `$source` string for the port GPS receiver | `GPS-Primary.GN` |
| Starboard antenna `$source` | `$source` string for the starboard GPS receiver | `GPS-Secondary.GN` |
| Port / stbd antenna positions | Distance aft of bow and athwartship offset for each antenna, in inches, feet, or metres | — |
| Calibration trim (°) | Constant offset added after geometric correction | `0` |
| EWMA filter alpha | Smoothing factor 0–1 (lower = smoother, higher = more responsive) | `0.15` |

Find the correct `$source` string for each GPS by expanding `navigation.position` in the Signal K **Data Browser** and reading the source label next to each value.

## Calibration

1. Moor the vessel at a berth with a known true bearing.
2. Note the heading the plugin reports.
3. Set **Calibration trim** to `(true bearing) − (reported heading)`.

## License

MIT
