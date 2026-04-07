import { state, wb } from './types.ts';

export function createSTDPanel(toolLayer: HTMLElement): void {
  if (document.getElementById('std-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'std-panel';
  panel.innerHTML = `
    <h4>Speed · Time · Distance</h4>
    <div class="std-row">
      <label>Speed</label>
      <input type="number" id="std-speed" min="0" max="30" step="0.1" value="6" />
      <span class="unit">kn</span>
    </div>
    <div class="std-row">
      <label>Time</label>
      <input type="number" id="std-time" min="0" max="9999" step="1" value="60" />
      <span class="unit">min</span>
    </div>
    <div class="std-row">
      <label>Distance</label>
      <span id="std-dist-out" class="std-computed">—</span>
      <span class="unit">NM</span>
    </div>
    <button id="std-push-btn">Push to Workbook</button>
  `;
  panel.style.left = '20px';
  panel.style.top  = '80px';
  toolLayer.appendChild(panel);

  const speedEl  = panel.querySelector<HTMLInputElement>('#std-speed')!;
  const timeEl   = panel.querySelector<HTMLInputElement>('#std-time')!;
  const distOut  = panel.querySelector<HTMLElement>('#std-dist-out')!;

  const update = (): void => {
    const s = parseFloat(speedEl.value) || 0;
    const t = parseFloat(timeEl.value) || 0;
    const dist = s * (t / 60);
    distOut.textContent = dist.toFixed(2);
    state.stdResult = { speed: s, timeMin: t, distNM: dist };
  };

  speedEl.addEventListener('input', update);
  timeEl.addEventListener('input', update);
  update();

  panel.querySelector('#std-push-btn')!.addEventListener('click', () => {
    const res = state.stdResult;
    if (!res) return;
    const depTimeEl = document.getElementById('wb-dep-time') as HTMLInputElement | null;
    const depTime = depTimeEl?.value ?? '09:00';
    const [hh = 9, mm = 0] = depTime.split(':').map(Number);
    const etaMins = hh * 60 + mm + res.timeMin;
    const etaH = Math.floor(etaMins / 60) % 24;
    const etaM = Math.round(etaMins % 60);
    const eta = `${String(etaH).padStart(2, '0')}:${String(etaM).padStart(2, '0')}`;
    wb.setETA?.(eta);
    const wbDist = document.getElementById('wb-distance');
    if (wbDist) wbDist.textContent = res.distNM.toFixed(2) + ' NM';
  });

  let dragging = false, ox = 0, oy = 0;
  panel.addEventListener('pointerdown', (ev: PointerEvent) => {
    const target = ev.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') return;
    dragging = true;
    panel.setPointerCapture(ev.pointerId);
    ox = ev.clientX - panel.offsetLeft;
    oy = ev.clientY - panel.offsetTop;
  });
  panel.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!dragging) return;
    panel.style.left = `${ev.clientX - ox}px`;
    panel.style.top  = `${ev.clientY - oy}px`;
  });
  panel.addEventListener('pointerup', () => { dragging = false; });
}

export function removeSTDPanel(): void {
  document.getElementById('std-panel')?.remove();
}
