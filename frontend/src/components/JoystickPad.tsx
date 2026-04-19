import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useT } from '../i18n';

interface JoystickPadProps {
  direction: number;
  intensity: number;
  active: boolean;           // true = joystick session started on backend
  onMove: (direction: number, intensity: number) => void;
  onRelease: () => void;
}

const PAD_RADIUS   = 70;
const HANDLE_RADIUS = 22;
const MAX_DISTANCE  = PAD_RADIUS - HANDLE_RADIUS;

const JoystickPad: React.FC<JoystickPadProps> = ({
  direction,
  intensity,
  active,
  onMove,
  onRelease,
}) => {
  const t = useT();
  const padRef   = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [handlePos, setHandlePos] = useState({ x: 0, y: 0 });

  // Reset handle when deactivated
  useEffect(() => {
    if (!active) {
      setDragging(false);
      setHandlePos({ x: 0, y: 0 });
    }
  }, [active]);

  const getDirectionLabel = (deg: number): string => {
    const d = ((deg % 360) + 360) % 360;
    if (d >= 337.5 || d < 22.5)  return t('joy.north');
    if (d >= 22.5  && d < 67.5)  return t('joy.northeast');
    if (d >= 67.5  && d < 112.5) return t('joy.east');
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
      const centerX = rect.left + rect.width  / 2;
      const centerY = rect.top  + rect.height / 2;

      const dx =   clientX - centerX;
      const dy = -(clientY - centerY); // invert Y for math coords

      const distance    = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(distance, MAX_DISTANCE);
      const normIntensity = clampedDist / MAX_DISTANCE;

      const radians  = Math.atan2(dx, dy);
      let compassDeg = (radians * 180) / Math.PI;
      if (compassDeg < 0) compassDeg += 360;

      const scale  = distance > 0 ? clampedDist / distance : 0;
      const visualX =  dx * scale;
      const visualY = -(dy * scale);

      setHandlePos({ x: visualX, y: visualY });
      onMove(Math.round(compassDeg), normIntensity);
    },
    [onMove],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    calcFromEvent(e.clientX, e.clientY);
  }, [active, calcFromEvent]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || !active) return;
    calcFromEvent(e.clientX, e.clientY);
  }, [dragging, active, calcFromEvent]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    setHandlePos({ x: 0, y: 0 });
    onRelease();
  }, [onRelease]);

  // ── WASD / Arrow keyboard control ────────────────────────────────────
  useEffect(() => {
    const pressed = new Set<string>();
    const KEY_DIR: Record<string, string> = {
      w: 'up', arrowup: 'up',
      s: 'down', arrowdown: 'down',
      a: 'left', arrowleft: 'left',
      d: 'right', arrowright: 'right',
    };

    const compute = () => {
      const up    = pressed.has('up');
      const down  = pressed.has('down');
      const left  = pressed.has('left');
      const right = pressed.has('right');
      if (!up && !down && !left && !right) return null;

      let dx = 0, dy = 0;
      if (up)    dy += 1;
      if (down)  dy -= 1;
      if (right) dx += 1;
      if (left)  dx -= 1;
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
        setHandlePos({ x: 0, y: 0 });
        onRelease();
        return;
      }
      setDragging(true);
      onMove(r.deg, 1);
      const len = Math.sqrt(r.dx * r.dx + r.dy * r.dy);
      setHandlePos({
        x:  (r.dx / len) * MAX_DISTANCE,
        y: -(r.dy / len) * MAX_DISTANCE,
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!active) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      e.preventDefault();
      if (!pressed.has(dir)) { pressed.add(dir); update(); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!active) return;
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      if (pressed.delete(dir)) update();
    };
    const onBlur = () => {
      if (pressed.size > 0) {
        pressed.clear();
        setDragging(false);
        setHandlePos({ x: 0, y: 0 });
        onRelease();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    window.addEventListener('blur',    onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      window.removeEventListener('blur',    onBlur);
    };
  }, [active, onMove, onRelease]);

  // Direction labels
  const arrows = [
    { label: t('joy.north'), x: 0,                  y: -(PAD_RADIUS + 20) },
    { label: t('joy.east'),  x:  PAD_RADIUS + 20,   y: 0 },
    { label: t('joy.south'), x: 0,                  y:  PAD_RADIUS + 20 },
    { label: t('joy.west'),  x: -(PAD_RADIUS + 20), y: 0 },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 60, right: 20,
        zIndex: 1000,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        userSelect: 'none', touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: PAD_RADIUS * 2 + 50, height: PAD_RADIUS * 2 + 50,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: active ? 1 : 0.45,
          transition: 'opacity 0.3s',
        }}
      >
        {/* Direction labels */}
        {arrows.map((a) => (
          <div
            key={a.label}
            style={{
              position: 'absolute',
              left: `calc(50% + ${a.x}px)`, top: `calc(50% + ${a.y}px)`,
              transform: 'translate(-50%, -50%)',
              fontSize: 11, fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            {a.label}
          </div>
        ))}

        {/* Pad background */}
        <div
          ref={padRef}
          style={{
            width: PAD_RADIUS * 2, height: PAD_RADIUS * 2,
            borderRadius: '50%',
            background: active ? 'rgba(30,30,40,0.82)' : 'rgba(20,20,28,0.65)',
            border: `2px solid ${active ? 'rgba(108,140,255,0.35)' : 'rgba(255,255,255,0.12)'}`,
            position: 'relative',
            cursor: active ? 'grab' : 'not-allowed',
            backdropFilter: 'blur(8px)',
            transition: 'border-color 0.3s, background 0.3s',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Crosshair */}
          <svg
            width={PAD_RADIUS * 2} height={PAD_RADIUS * 2}
            viewBox={`0 0 ${PAD_RADIUS * 2} ${PAD_RADIUS * 2}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          >
            <line x1={PAD_RADIUS} y1="10" x2={PAD_RADIUS} y2={PAD_RADIUS * 2 - 10}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <line x1="10" y1={PAD_RADIUS} x2={PAD_RADIUS * 2 - 10} y2={PAD_RADIUS}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={PAD_RADIUS - 5}
              fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={MAX_DISTANCE / 2}
              fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
          </svg>

          {/* Handle */}
          <div
            style={{
              width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
              borderRadius: '50%',
              background: !active
                ? 'radial-gradient(circle, #555 0%, #333 100%)'
                : dragging
                  ? 'radial-gradient(circle, #6b8afd 0%, #4a6cf7 100%)'
                  : 'radial-gradient(circle, #888 0%, #555 100%)',
              border: '2px solid rgba(255,255,255,0.3)',
              position: 'absolute',
              left: PAD_RADIUS - HANDLE_RADIUS + handlePos.x,
              top:  PAD_RADIUS - HANDLE_RADIUS + handlePos.y,
              transition: dragging ? 'none' : 'left 0.2s ease-out, top 0.2s ease-out',
              pointerEvents: 'none',
              boxShadow: dragging ? '0 0 12px rgba(74,108,247,0.5)' : '0 2px 6px rgba(0,0,0,0.3)',
            }}
          />

          {/* "Not started" overlay */}
          {!active && (
            <div
              style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: 'rgba(255,255,255,0.6)',
                textAlign: 'center', padding: '0 12px', lineHeight: 1.5,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                style={{ marginBottom: 4, opacity: 0.7 }}>
                <polygon points="5,3 19,12 5,21" />
              </svg>
              按 ▶ 啟動
            </div>
          )}
        </div>
      </div>

      {/* Info bar */}
      <div
        style={{
          marginTop: 6, textAlign: 'center',
          fontSize: 12, color: 'rgba(255,255,255,0.85)',
          background: 'rgba(18,18,26,0.78)',
          padding: '4px 14px', borderRadius: 6,
          backdropFilter: 'blur(4px)', minWidth: 150,
        }}
      >
        {!active ? (
          <span style={{ opacity: 0.55 }}>搖桿未啟動</span>
        ) : intensity > 0.01 ? (
          <>{getDirectionLabel(direction)} · {(intensity * 100).toFixed(0)}%</>
        ) : (
          <span style={{ opacity: 0.7 }}>{t('joy.drag_or_keys')}</span>
        )}
      </div>
    </div>
  );
};

export default JoystickPad;
