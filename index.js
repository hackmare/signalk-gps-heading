module.exports = function(app) {
  const plugin = {};
  let unsubscribes = [];
  let lastPort = null;
  let lastStbd = null;
  let filtered = null;
  let seenSources = new Set();

  plugin.id = 'signalk-gps-heading';
  plugin.name = 'GPS-derived heading';
  plugin.description = 'Computes vessel heading and midpoint position from two GPS antennas';

  // Source label for all data this plugin publishes. Used both as the
  // handleMessage source argument and in the feedback-loop guard —
  // these MUST stay identical.
  const SOURCE_LABEL = 'dual-gps';

  const lengthField = (titleStr, descStr, defaultValue, defaultUnit) => ({
    type: 'object',
    title: titleStr,
    description: descStr,
    properties: {
      value: { type: 'number', title: 'Value', default: defaultValue },
      unit:  { type: 'string', title: 'Unit', enum: ['in', 'ft', 'm'], default: defaultUnit }
    }
  });

  plugin.schema = {
    type: 'object',
    properties: {
      portSource: {
        type: 'string',
        title: 'Port antenna $source',
        description: 'SignalK $source string for the port GPS receiver. Verify by expanding the source in Data Browser → navigation.position.',
        default: 'GPS-Primary.GN'
      },
      stbdSource: {
        type: 'string',
        title: 'Starboard antenna $source',
        description: 'SignalK $source string for the starboard GPS receiver.',
        default: 'GPS-Secondary.GN'
      },
      portDistanceFromBow: lengthField(
        'Port antenna: distance aft of bow',
        'Distance from bow stem to port antenna, measured along the fore-aft axis (parallel to centerline).',
        60, 'ft'
      ),
      portDistanceAthwart: lengthField(
        'Port antenna: distance to port of centerline',
        'Perpendicular distance from centerline to port antenna. Always positive.',
        8.5, 'ft'
      ),
      portHeightAboveWaterline: lengthField(
        'Port antenna: height above waterline',
        'Vertical position of port antenna phase center above the static waterline. Currently informational; reserved for future lever-arm correction once IMU attitude data is available.',
        268, 'in'
      ),
      stbdDistanceFromBow: lengthField(
        'Starboard antenna: distance aft of bow',
        'Distance from bow stem to starboard antenna, measured along the fore-aft axis.',
        60, 'ft'
      ),
      stbdDistanceAthwart: lengthField(
        'Starboard antenna: distance to starboard of centerline',
        'Perpendicular distance from centerline to starboard antenna. Always positive.',
        8.0, 'ft'
      ),
      stbdHeightAboveWaterline: lengthField(
        'Starboard antenna: height above waterline',
        'Vertical position of starboard antenna phase center.',
        226, 'in'
      ),
      trimDegrees: {
        type: 'number',
        title: 'Calibration trim (degrees)',
        description: 'Final constant offset applied after geometric correction. Use to absorb residual mounting error and reference-frame offsets. Determined by parking the vessel at a known true bearing and computing (true - reported).',
        default: 0
      },
      filterAlpha: {
        type: 'number',
        title: 'EWMA filter alpha (0-1)',
        description: 'Smoothing factor for heading. Lower = smoother but laggier; higher = more responsive but noisier. 0.15 ≈ 7 sec time constant at 1 Hz.',
        default: 0.15
      }
    }
  };

  function toMeters(m) {
    if (!m || typeof m.value !== 'number') return 0;
    switch (m.unit) {
      case 'in': return m.value * 0.0254;
      case 'ft': return m.value * 0.3048;
      case 'm':  return m.value;
      default:   return m.value;
    }
  }

  function updateStatus(options) {
    const haveP = lastPort ? 'P' : '-';
    const haveS = lastStbd ? 'S' : '-';
    const sources = [...seenSources].join(', ') || '(none yet)';
    if (lastPort && lastStbd && filtered !== null) {
      app.setPluginStatus(`Heading: ${(filtered * 180/Math.PI).toFixed(1)}° | seen: ${sources}`);
    } else {
      app.setPluginStatus(`Waiting [${haveP}${haveS}] | want: "${options.portSource}", "${options.stbdSource}" | seen: ${sources}`);
    }
  }

  plugin.start = function(options) {
    app.debug(`Starting. portSource="${options.portSource}", stbdSource="${options.stbdSource}"`);
    seenSources = new Set();
    lastPort = lastStbd = filtered = null;

    const bus = app.streambundle.getBus('navigation.position');
    const unsub = bus.onValue((normalizedDelta) => {
      const src = normalizedDelta['$source'];

      // Ignore our own midpoint publication — prevents an infinite feedback loop
      if (src === SOURCE_LABEL) return;

      if (!seenSources.has(src)) {
        seenSources.add(src);
        app.debug(`First time seeing source on navigation.position: "${src}"`);
      }

      // Only recompute when a real GPS source delivered new data
      let updated = false;
      if (src === options.portSource) { lastPort = normalizedDelta.value; updated = true; }
      else if (src === options.stbdSource) { lastStbd = normalizedDelta.value; updated = true; }

      if (updated && lastPort && lastStbd) computeAndSend(options);
      else updateStatus(options);
    });
    unsubscribes.push(unsub);
    updateStatus(options);
  };

  function computeAndSend(options) {
    const toRad = d => d * Math.PI / 180;

    // Earth-frame bearing from port antenna to starboard antenna (CW from north)
    const φ1 = toRad(lastPort.latitude), φ2 = toRad(lastStbd.latitude);
    const Δλ = toRad(lastStbd.longitude - lastPort.longitude);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
    const bearing = Math.atan2(y, x);

    // Antenna positions in vessel frame, converted to meters
    const portFwd = toMeters(options.portDistanceFromBow);
    const stbdFwd = toMeters(options.stbdDistanceFromBow);
    const portAth = toMeters(options.portDistanceAthwart);
    const stbdAth = toMeters(options.stbdDistanceAthwart);

    // Vector from port to starboard antenna in vessel frame
    const vFwd = portFwd - stbdFwd;
    const vStb = portAth + stbdAth;
    const thetaV = Math.atan2(vStb, vFwd);

    // Vessel heading
    let heading = bearing - thetaV + toRad(options.trimDegrees);
    heading = ((heading % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);

    // Circular EWMA filter (sin/cos averaging handles wraparound at 0/2π)
    const α = options.filterAlpha;
    if (filtered === null) {
      filtered = heading;
    } else {
      const sn = α*Math.sin(heading) + (1-α)*Math.sin(filtered);
      const cn = α*Math.cos(heading) + (1-α)*Math.cos(filtered);
      filtered = ((Math.atan2(sn, cn) % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
    }

    // Midpoint position. Simple arithmetic mean is accurate at 16 ft scale;
    // ECEF conversion is overkill below ~1 km.
    const midPos = {
      latitude:  (lastPort.latitude  + lastStbd.latitude)  / 2,
      longitude: (lastPort.longitude + lastStbd.longitude) / 2
    };
    if (lastPort.altitude !== undefined && lastStbd.altitude !== undefined) {
      midPos.altitude = (lastPort.altitude + lastStbd.altitude) / 2;
    }

    // Single delta carrying both values, published under the SOURCE_LABEL source
    app.handleMessage(SOURCE_LABEL, {
      updates: [{
        values: [
          { path: 'navigation.position', value: midPos },
          { path: 'navigation.headingTrue', value: filtered }
        ]
      }]
    });
    updateStatus(options);
  }

  plugin.stop = function() {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    lastPort = lastStbd = filtered = null;
    seenSources = new Set();
    app.setPluginStatus('Stopped');
  };

  return plugin;
};
