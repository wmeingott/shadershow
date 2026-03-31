// Art-Net DMX Mapping Dialog — configure DMX channel → app control mappings

import { state } from '../core/state.js';
import type { ArtNetMapping, ArtNetTarget } from '@shared/types/artnet.js';
import type { ParamDef } from '@shared/types/index.js';

// Renderer interface for getting param defs
interface RendererLike {
  getCustomParamDefs?(): ParamDef[];
}

declare const window: Window & {
  electronAPI: {
    getArtNetDmxValues(): Promise<number[]>;
  };
};

/** Current mappings being edited */
let editMappings: ArtNetMapping[] = [];
let learnMode = false;
let learnPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Show the Art-Net DMX mapping configuration dialog.
 * @param mappings Current mappings to edit
 * @param onSave Callback with updated mappings
 */
export function showArtNetMappingDialog(
  mappings: ArtNetMapping[],
  onSave: (mappings: ArtNetMapping[]) => void,
): void {
  // Deep clone
  editMappings = JSON.parse(JSON.stringify(mappings));
  learnMode = false;

  const overlay = document.createElement('div');
  overlay.id = 'artnet-mapping-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 10000;
  `;

  overlay.innerHTML = `
    <div class="artnet-mapping-dialog" style="
      background: var(--bg-primary, #1e1e1e); color: var(--text-primary, #ccc);
      border: 1px solid var(--border-color, #555); border-radius: 6px;
      width: 700px; max-height: 80vh; display: flex; flex-direction: column;
      font-size: 13px;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #555);">
        <h3 style="margin: 0; font-size: 15px;">Art-Net DMX Mappings</h3>
        <button id="artnet-close-btn" style="background: none; border: none; color: var(--text-primary); font-size: 18px; cursor: pointer;">&times;</button>
      </div>
      <div style="padding: 12px 16px; display: flex; gap: 8px; border-bottom: 1px solid var(--border-color, #333);">
        <button id="artnet-add-btn" class="btn-secondary" style="font-size: 12px;">+ Add Mapping</button>
        <button id="artnet-learn-btn" class="btn-secondary" style="font-size: 12px;">Learn</button>
        <span id="artnet-learn-status" style="color: var(--text-secondary); font-size: 11px; align-self: center;"></span>
      </div>
      <div id="artnet-mapping-list" style="overflow-y: auto; flex: 1; padding: 8px 16px; min-height: 120px;"></div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-color, #555);">
        <button id="artnet-cancel-btn" class="btn-secondary">Cancel</button>
        <button id="artnet-save-btn" class="btn-primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Render the mapping list
  renderMappingList();

  // Wire buttons
  overlay.querySelector('#artnet-close-btn')!.addEventListener('click', close);
  overlay.querySelector('#artnet-cancel-btn')!.addEventListener('click', close);
  overlay.querySelector('#artnet-save-btn')!.addEventListener('click', () => {
    onSave(editMappings);
    close();
  });
  overlay.querySelector('#artnet-add-btn')!.addEventListener('click', () => {
    editMappings.push({ dmxChannel: 1, target: { type: 'speed' } });
    renderMappingList();
  });
  overlay.querySelector('#artnet-learn-btn')!.addEventListener('click', toggleLearn);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Close on Escape
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', keyHandler);

  function close(): void {
    stopLearn();
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  }
}

/** Get available param names from current shader */
function getParamNames(): string[] {
  const renderer = state.renderer as RendererLike | null;
  if (!renderer?.getCustomParamDefs) return [];
  return renderer.getCustomParamDefs().map(d => d.name);
}

/** Render the mapping list */
function renderMappingList(): void {
  const list = document.getElementById('artnet-mapping-list');
  if (!list) return;

  if (editMappings.length === 0) {
    list.innerHTML = '<div style="color: var(--text-secondary); padding: 20px; text-align: center;">No mappings configured. Click "+ Add Mapping" or "Learn" to begin.</div>';
    return;
  }

  const paramNames = getParamNames();

  list.innerHTML = editMappings.map((m, i) => `
    <div class="artnet-mapping-row" style="display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border-color, #333);" data-index="${i}">
      <label style="font-size: 11px; color: var(--text-secondary); width: 25px;">CH</label>
      <input type="number" class="artnet-ch-input" value="${m.dmxChannel}" min="1" max="512" style="width: 55px; background: var(--bg-secondary, #2a2a2a); color: var(--text-primary); border: 1px solid var(--border-color, #555); padding: 3px 5px; font-size: 12px;">
      <select class="artnet-target-type" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <option value="speed" ${m.target.type === 'speed' ? 'selected' : ''}>Speed</option>
        <option value="param" ${m.target.type === 'param' ? 'selected' : ''}>Parameter</option>
        <option value="mixer-alpha" ${m.target.type === 'mixer-alpha' ? 'selected' : ''}>Mixer Alpha</option>
        <option value="mixer-select" ${m.target.type === 'mixer-select' ? 'selected' : ''}>Mixer Select</option>
        <option value="vp-recall" ${m.target.type === 'vp-recall' ? 'selected' : ''}>VP Recall</option>
        <option value="preset-recall" ${m.target.type === 'preset-recall' ? 'selected' : ''}>Preset Recall</option>
        <option value="blackout" ${m.target.type === 'blackout' ? 'selected' : ''}>Blackout</option>
      </select>
      ${renderTargetOptions(m.target, paramNames)}
      <button class="artnet-remove-btn" style="background: none; border: none; color: #f66; cursor: pointer; font-size: 16px; padding: 2px 6px;" title="Remove">&times;</button>
    </div>
  `).join('');

  // Wire change handlers
  list.querySelectorAll('.artnet-mapping-row').forEach((row) => {
    const idx = parseInt(row.getAttribute('data-index')!);

    const chInput = row.querySelector('.artnet-ch-input') as HTMLInputElement;
    chInput.addEventListener('change', () => {
      const val = parseInt(chInput.value);
      if (val >= 1 && val <= 512) editMappings[idx]!.dmxChannel = val;
    });

    const typeSelect = row.querySelector('.artnet-target-type') as HTMLSelectElement;
    typeSelect.addEventListener('change', () => {
      editMappings[idx]!.target = createDefaultTarget(typeSelect.value);
      renderMappingList();
    });

    // Target-specific inputs
    const paramSelect = row.querySelector('.artnet-param-name') as HTMLSelectElement | null;
    paramSelect?.addEventListener('change', () => {
      (editMappings[idx]!.target as { name: string }).name = paramSelect.value;
    });

    const chIdxInput = row.querySelector('.artnet-ch-idx') as HTMLInputElement | null;
    chIdxInput?.addEventListener('change', () => {
      (editMappings[idx]!.target as { channelIndex: number }).channelIndex = parseInt(chIdxInput.value) || 0;
    });

    const vpTabInput = row.querySelector('.artnet-vp-tab') as HTMLInputElement | null;
    vpTabInput?.addEventListener('change', () => {
      (editMappings[idx]!.target as { vpTabIndex: number }).vpTabIndex = parseInt(vpTabInput.value) || 0;
    });

    const presetInput = row.querySelector('.artnet-preset-idx') as HTMLInputElement | null;
    presetInput?.addEventListener('change', () => {
      (editMappings[idx]!.target as { presetIndex: number }).presetIndex = parseInt(presetInput.value) || 0;
    });

    const removeBtn = row.querySelector('.artnet-remove-btn') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
      editMappings.splice(idx, 1);
      renderMappingList();
    });
  });
}

/** Render target-specific option inputs */
function renderTargetOptions(target: ArtNetTarget, paramNames: string[]): string {
  switch (target.type) {
    case 'speed':
      return '<span style="color: var(--text-secondary); font-size: 11px; flex: 1;">0-255 → 0.0-2.0</span>';
    case 'param': {
      const name = target.name || '';
      const options = paramNames.map(p => `<option value="${p}" ${p === name ? 'selected' : ''}>${p}</option>`).join('');
      return `<select class="artnet-param-name" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px; flex: 1;">
        <option value="">-- select --</option>${options}</select>`;
    }
    case 'mixer-alpha':
      return `<label style="font-size: 11px; color: var(--text-secondary);">Ch:</label>
        <input type="number" class="artnet-ch-idx" value="${target.channelIndex}" min="0" max="7" style="width: 40px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">`;
    case 'mixer-select':
      return `<label style="font-size: 11px; color: var(--text-secondary);">Ch:</label>
        <input type="number" class="artnet-ch-idx" value="${target.channelIndex}" min="0" max="7" style="width: 40px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">`;
    case 'vp-recall':
      return `<label style="font-size: 11px; color: var(--text-secondary);">Tab:</label>
        <input type="number" class="artnet-vp-tab" value="${target.vpTabIndex}" min="0" max="20" style="width: 40px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <label style="font-size: 11px; color: var(--text-secondary);">Preset:</label>
        <input type="number" class="artnet-preset-idx" value="${target.presetIndex}" min="0" max="99" style="width: 40px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">`;
    case 'preset-recall':
      return `<label style="font-size: 11px; color: var(--text-secondary);">Preset:</label>
        <input type="number" class="artnet-preset-idx" value="${target.presetIndex}" min="0" max="19" style="width: 40px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">`;
    case 'blackout':
      return '<span style="color: var(--text-secondary); font-size: 11px; flex: 1;">Toggle on rising edge (>127)</span>';
  }
}

/** Create a default target for a given type */
function createDefaultTarget(type: string): ArtNetTarget {
  switch (type) {
    case 'speed': return { type: 'speed' };
    case 'param': return { type: 'param', name: '' };
    case 'mixer-alpha': return { type: 'mixer-alpha', channelIndex: 0 };
    case 'mixer-select': return { type: 'mixer-select', channelIndex: 0 };
    case 'vp-recall': return { type: 'vp-recall', vpTabIndex: 0, presetIndex: 0 };
    case 'preset-recall': return { type: 'preset-recall', presetIndex: 0 };
    case 'blackout': return { type: 'blackout' };
    default: return { type: 'speed' };
  }
}

/** Toggle DMX learn mode — polls for changing DMX values and auto-creates a mapping */
function toggleLearn(): void {
  const btn = document.getElementById('artnet-learn-btn');
  const status = document.getElementById('artnet-learn-status');

  if (learnMode) {
    stopLearn();
    return;
  }

  learnMode = true;
  if (btn) btn.textContent = 'Stop Learn';
  if (status) status.textContent = 'Move a fader on your DMX controller...';

  let prevValues: number[] | null = null;

  learnPollTimer = setInterval(async () => {
    try {
      const values = await window.electronAPI.getArtNetDmxValues();
      if (prevValues) {
        // Find the channel with the largest change
        let maxDelta = 0;
        let maxCh = -1;
        for (let i = 0; i < 512; i++) {
          const delta = Math.abs((values[i] ?? 0) - (prevValues[i] ?? 0));
          if (delta > maxDelta) {
            maxDelta = delta;
            maxCh = i;
          }
        }
        if (maxDelta > 20 && maxCh >= 0) {
          // Found a moving fader — create mapping for it
          const dmxChannel = maxCh + 1; // 1-based
          // Don't add duplicate
          if (!editMappings.some(m => m.dmxChannel === dmxChannel)) {
            editMappings.push({ dmxChannel, target: { type: 'speed' } });
            renderMappingList();
          }
          if (status) status.textContent = `Detected CH ${dmxChannel} — added mapping`;
          stopLearn();
        }
      }
      prevValues = values;
    } catch {
      // Art-Net not active
    }
  }, 100);
}

function stopLearn(): void {
  learnMode = false;
  if (learnPollTimer) {
    clearInterval(learnPollTimer);
    learnPollTimer = null;
  }
  const btn = document.getElementById('artnet-learn-btn');
  if (btn) btn.textContent = 'Learn';
  const status = document.getElementById('artnet-learn-status');
  if (status) status.textContent = '';
}
