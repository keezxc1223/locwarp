import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useT } from '../i18n';

interface JoystickPadProps {
  direction: number;
  intensity: number;
  onMove: (direction: number, intensity: number) => void;
  onRelease: () => void;
}

const PAD_RADIUS = 70;
const HANDLE_RADIUS = 22;
const MAX_DISTANCE = PAD_RADIUS - HANDLE_RADIUS;
const SMOOTH_TAU_MS = 40;

const JoystickPad: React.FC<JoystickPadProps> = ({
  direction,
  intensity,
  onMove,
  onRelease,
}) => {
  const t = useT();
  const padRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [visualPos, setVisualPos] = useState({ x: 0, y: 0 });
  const targetPosRef = useRef({ x: 0, y: 0 });
  const visualPosRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  const tick = useCallback((now: number) => {
    const dt = lastFrameRef.current ? now - lastFrameRef.current : 16;
    lastFrameRef.current = now;
    const target = targetPosRef.current;
    const current = visualPosRef.current;
    const dx = target.x - current.x;
    const dy = target.y - current.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) {
      visualPosRef.current = { x: target.x, y: target.y };
      setVisualPos({ x: target.x, y: target.y });
      rafRef.current = null;
      lastFrameRef.current = 0;
      return;
    }
    const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    const next = { x: current.x + dx * alpha, y: current.y + dy * alpha };
    visualPosRef.current = next;
    setVisualPos(next);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const setTarget = useCallback((x: number, y: number) => {
    targetPosRef.current = { x, y };
    if (rafRef.current == null) {
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const getDirectionLabel = (deg: number): string => {
    // deg is compass degrees: 0=N, 90=E, 180=S, 270=W
    const d = ((deg % 360) + 360) % 360;
    if (d >= 337.5 || d < 22.5) return t('joy.north');
    if (d >= 22.5 && d < 67.5) return t('joy.northeast');
    if (d >= 67.5 && d < 112.5) return t('joy.east');
    if (d >= 112.5 && d < 157.5) return t('joy.southeast');
    if (d >= 157.5 && d < 202.5) return t('joy.south');
    if (d >= 202.5 && d < 247.5) return t('joy.southwest');
    if (d >= 247.5 && d < 292.5) return t('joy.west');
    return t('joy.northwest');
  };

  const calcFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      if (!padRef.current) return;
      const rect = padRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      let dx = clientX - centerX;
      let dy = -(clientY - centerY); // Invert Y for math coords

      const distance = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(distance, MAX_DISTANCE);
      const normIntensity = clampedDist / MAX_DISTANCE;

      // Convert to compass degrees: 0=N, 90=E, 180=S, 270=W
      // atan2(dx, dy) gives 0=N, π/2=E, matching compass convention
      const radians = Math.atan2(dx, dy);
      let compassDeg = (radians * 180) / Math.PI;
      if (compassDeg < 0) compassDeg += 360;

      // Clamp handle position visually
      const scale = distance > 0 ? clampedDist / distance : 0;
      const visualX = dx * scale;
      const visualY = -(dy * scale); // Back to screen coords

      setTarget(visualX, visualY);
      onMove(Math.round(compassDeg), normIntensity);
    },
    [onMove, setTarget]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setDragging(true);
      // Capture on currentTarget (the pad div with the handlers), not e.target
      // which can resolve to an inner child and break capture semantics,
      // causing the pointer to escape when dragged outside the pad.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      calcFromEvent(e.clientX, e.clientY);
    },
    [calcFromEvent]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      calcFromEvent(e.clientX, e.clientY);
    },
    [dragging, calcFromEvent]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    setTarget(0, 0);
    onRelease();
  }, [onRelease, setTarget]);

  // ── WASD / arrow keyboard control ───────────────────
  useEffect(() => {
    const pressed = new Set<string>();
    const KEY_DIR: Record<string, string> = {
      w: 'up', arrowup: 'up',
      s: 'down', arrowdown: 'down',
      a: 'left', arrowleft: 'left',
      d: 'right', arrowright: 'right',
    };

    // Map direction set → (compass deg, intensity)
    const compute = () => {
      const up = pressed.has('up');
      const down = pressed.has('down');
      const left = pressed.has('left');
      const right = pressed.has('right');
      if (!up && !down && !left && !right) return null;

      let dx = 0, dy = 0;
      if (up) dy += 1;
      if (down) dy -= 1;
      if (right) dx += 1;
      if (left) dx -= 1;
      if (dx === 0 && dy === 0) return null;

      const rad = Math.atan2(dx, dy);
      let deg = (rad * 180) / Math.PI;
      if (deg < 0) deg += 360;
      return { deg: Math.round(deg), dx, dy };
    };

    const update = () => {
      const r = compute();
      if (!r) {
        setDragging(false);
        setTarget(0, 0);
        onRelease();
        return;
      }
      setDragging(true);
      onMove(r.deg, 1);
      const len = Math.sqrt(r.dx * r.dx + r.dy * r.dy);
      setTarget(
        (r.dx / len) * MAX_DISTANCE,
        -(r.dy / len) * MAX_DISTANCE,
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in inputs/textareas
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      e.preventDefault();
      if (!pressed.has(dir)) {
        pressed.add(dir);
        update();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      if (pressed.delete(dir)) update();
    };
    const onBlur = () => {
      if (pressed.size > 0) {
        pressed.clear();
        setDragging(false);
        setTarget(0, 0);
        onRelease();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onMove, onRelease, setTarget]);

  // Direction arrows around the pad
  const arrows = [
    { deg: 0, label: t('joy.east'), x: PAD_RADIUS + 20, y: 0 },
    { deg: 90, label: t('joy.north'), x: 0, y: -(PAD_RADIUS + 20) },
    { deg: 180, label: t('joy.west'), x: -(PAD_RADIUS + 20), y: 0 },
    { deg: 270, label: t('joy.south'), x: 0, y: PAD_RADIUS + 20 },
  ];

  return (
    <div
      className="joystick-overlay"
      style={{
        position: 'absolute',
        bottom: 60,
        right: 20,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: PAD_RADIUS * 2 + 50,
          height: PAD_RADIUS * 2 + 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Direction labels */}
        {arrows.map((a) => (
          <div
            key={a.label}
            style={{
              position: 'absolute',
              left: `calc(50% + ${a.x}px)`,
              top: `calc(50% + ${a.y}px)`,
              transform: 'translate(-50%, -50%)',
              fontSize: 11,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            {a.label}
          </div>
        ))}

        {/* Pad background */}
        <div
          ref={padRef}
          className="joystick-pad"
          style={{
            width: PAD_RADIUS * 2,
            height: PAD_RADIUS * 2,
            borderRadius: '50%',
            background: 'rgba(30, 30, 40, 0.75)',
            border: '2px solid rgba(255,255,255,0.15)',
            position: 'relative',
            cursor: 'grab',
            backdropFilter: 'blur(8px)',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Crosshair lines */}
          <svg
            width={PAD_RADIUS * 2}
            height={PAD_RADIUS * 2}
            viewBox={`0 0 ${PAD_RADIUS * 2} ${PAD_RADIUS * 2}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          >
            <line x1={PAD_RADIUS} y1="10" x2={PAD_RADIUS} y2={PAD_RADIUS * 2 - 10} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <line x1="10" y1={PAD_RADIUS} x2={PAD_RADIUS * 2 - 10} y2={PAD_RADIUS} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={PAD_RADIUS - 5} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={MAX_DISTANCE / 2} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
          </svg>

          {/* Handle */}
          <div
            className="joystick-handle"
            style={{
              width: HANDLE_RADIUS * 2,
              height: HANDLE_RADIUS * 2,
              borderRadius: '50%',
              background: dragging
                ? 'radial-gradient(circle, #6b8afd 0%, #4a6cf7 100%)'
                : 'radial-gradient(circle, #888 0%, #555 100%)',
              border: '2px solid rgba(255,255,255,0.3)',
              position: 'absolute',
              left: PAD_RADIUS - HANDLE_RADIUS + visualPos.x,
              top: PAD_RADIUS - HANDLE_RADIUS + visualPos.y,
              pointerEvents: 'none',
              boxShadow: dragging ? '0 0 12px rgba(74,108,247,0.5)' : '0 2px 6px rgba(0,0,0,0.3)',
              willChange: 'left, top',
            }}
          />
        </div>
      </div>

      {/* Info text */}
      <div
        style={{
          marginTop: 8,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(255,255,255,0.7)',
          background: 'rgba(30, 30, 40, 0.65)',
          padding: '4px 12px',
          borderRadius: 4,
          backdropFilter: 'blur(4px)',
        }}
      >
        {intensity > 0.01 ? (
          <>
            {getDirectionLabel(direction)} | {(intensity * 100).toFixed(0)}%
          </>
        ) : (
          t('joy.drag_or_keys')
        )}
      </div>
    </div>
  );
};

export default JoystickPad;
