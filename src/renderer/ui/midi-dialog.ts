// MIDI Mapping Dialog — configure MIDI CC/note → app control mappings.
// Mirrors artnet-dialog.ts and reuses its target-editor helpers.

import type { MidiMapping, MidiLearnEvent } from '@shared/types/midi.js';
import {
  getParamNames,
  renderTargetOptions,
  createDefaultTarget,
  wireTargetInputs,
} from './artnet-dialog.js';
import { setMidiLearnCallback } from './midi.js';

/** Current mappings being edited */
let editMappings: MidiMapping[] = [];
let learnMode = false;

/**
 * Show the MIDI mapping configuration dialog.
 * @param mappings Current mappings to edit
 * @param onSave Callback with updated mappings
 */
export function showMidiMappingDialog(
  mappings: MidiMapping[],
  onSave: (mappings: MidiMapping[]) => void,
): void {
  editMappings = JSON.parse(JSON.stringify(mappings));
  learnMode = false;

  const overlay = document.createElement('div');
  overlay.id = 'midi-mapping-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 10000;
  `;

  overlay.innerHTML = `
    <div class="midi-mapping-dialog" style="
      background: var(--bg-primary, #1e1e1e); color: var(--text-primary, #ccc);
      border: 1px solid var(--border-color, #555); border-radius: 6px;
      width: 760px; max-height: 80vh; display: flex; flex-direction: column;
      font-size: 13px;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border-color, #555);">
        <h3 style="margin: 0; font-size: 15px;">MIDI Mappings</h3>
        <button id="midi-close-btn" style="background: none; border: none; color: var(--text-primary); font-size: 18px; cursor: pointer;">&times;</button>
      </div>
      <div style="padding: 12px 16px; display: flex; gap: 8px; border-bottom: 1px solid var(--border-color, #333);">
        <button id="midi-add-btn" class="btn-secondary" style="font-size: 12px;">+ Add Mapping</button>
        <button id="midi-learn-btn" class="btn-secondary" style="font-size: 12px;">Learn</button>
        <span id="midi-learn-status" style="color: var(--text-secondary); font-size: 11px; align-self: center;"></span>
      </div>
      <div id="midi-mapping-list" style="overflow-y: auto; flex: 1; padding: 8px 16px; min-height: 120px;"></div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-color, #555);">
        <button id="midi-cancel-btn" class="btn-secondary">Cancel</button>
        <button id="midi-save-btn" class="btn-primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  renderMappingList();

  overlay.querySelector('#midi-close-btn')!.addEventListener('click', close);
  overlay.querySelector('#midi-cancel-btn')!.addEventListener('click', close);
  overlay.querySelector('#midi-save-btn')!.addEventListener('click', () => {
    onSave(editMappings);
    close();
  });
  overlay.querySelector('#midi-add-btn')!.addEventListener('click', () => {
    editMappings.push({ channel: 0, kind: 'cc', number: 1, target: { type: 'speed' } });
    renderMappingList();
  });
  overlay.querySelector('#midi-learn-btn')!.addEventListener('click', toggleLearn);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

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

/** Render the mapping list */
function renderMappingList(): void {
  const list = document.getElementById('midi-mapping-list');
  if (!list) return;

  if (editMappings.length === 0) {
    list.innerHTML = '<div style="color: var(--text-secondary); padding: 20px; text-align: center;">No mappings configured. Click "+ Add Mapping" or "Learn" to begin.</div>';
    return;
  }

  const paramNames = getParamNames();
  const chOptions = (sel: number) =>
    `<option value="0" ${sel === 0 ? 'selected' : ''}>Any</option>` +
    Array.from({ length: 16 }, (_, i) =>
      `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');

  list.innerHTML = editMappings.map((m, i) => `
    <div class="midi-mapping-row" style="display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border-color, #333);" data-index="${i}">
      <label style="font-size: 11px; color: var(--text-secondary);">CH</label>
      <select class="midi-ch-select" style="background: var(--bg-secondary, #2a2a2a); color: var(--text-primary); border: 1px solid var(--border-color, #555); padding: 3px; font-size: 12px;">${chOptions(m.channel)}</select>
      <select class="midi-kind-select" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <option value="cc" ${m.kind === 'cc' ? 'selected' : ''}>CC</option>
        <option value="note" ${m.kind === 'note' ? 'selected' : ''}>Note</option>
      </select>
      <input type="number" class="midi-num-input" value="${m.number}" min="0" max="127" style="width: 50px; background: var(--bg-secondary, #2a2a2a); color: var(--text-primary); border: 1px solid var(--border-color, #555); padding: 3px 5px; font-size: 12px;">
      <select class="midi-target-type" style="background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); padding: 3px; font-size: 12px;">
        <option value="speed" ${m.target.type === 'speed' ? 'selected' : ''}>Speed</option>
        <option value="param" ${m.target.type === 'param' ? 'selected' : ''}>Parameter</option>
        <option value="mixer-alpha" ${m.target.type === 'mixer-alpha' ? 'selected' : ''}>Mixer Alpha</option>
        <option value="mixer-select" ${m.target.type === 'mixer-select' ? 'selected' : ''}>Mixer Select</option>
        <option value="vp-recall" ${m.target.type === 'vp-recall' ? 'selected' : ''}>VP Recall</option>
        <option value="preset-recall" ${m.target.type === 'preset-recall' ? 'selected' : ''}>Preset Recall</option>
        <option value="blackout" ${m.target.type === 'blackout' ? 'selected' : ''}>Blackout</option>
      </select>
      ${renderTargetOptions(m.target, paramNames)}
      <button class="midi-remove-btn" style="background: none; border: none; color: #f66; cursor: pointer; font-size: 16px; padding: 2px 6px;" title="Remove">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.midi-mapping-row').forEach((row) => {
    const idx = parseInt(row.getAttribute('data-index')!);
    const mapping = editMappings[idx]!;

    const chSelect = row.querySelector('.midi-ch-select') as HTMLSelectElement;
    chSelect.addEventListener('change', () => {
      mapping.channel = parseInt(chSelect.value) || 0;
    });

    const kindSelect = row.querySelector('.midi-kind-select') as HTMLSelectElement;
    kindSelect.addEventListener('change', () => {
      mapping.kind = kindSelect.value === 'note' ? 'note' : 'cc';
    });

    const numInput = row.querySelector('.midi-num-input') as HTMLInputElement;
    numInput.addEventListener('change', () => {
      const val = parseInt(numInput.value);
      if (val >= 0 && val <= 127) mapping.number = val;
    });

    const typeSelect = row.querySelector('.midi-target-type') as HTMLSelectElement;
    typeSelect.addEventListener('change', () => {
      mapping.target = createDefaultTarget(typeSelect.value);
      renderMappingList();
    });

    wireTargetInputs(row, mapping.target);

    const removeBtn = row.querySelector('.midi-remove-btn') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
      editMappings.splice(idx, 1);
      renderMappingList();
    });
  });
}

/** Toggle MIDI learn — next incoming CC/note creates a mapping */
function toggleLearn(): void {
  if (learnMode) {
    stopLearn();
    return;
  }
  learnMode = true;
  const btn = document.getElementById('midi-learn-btn');
  const status = document.getElementById('midi-learn-status');
  if (btn) btn.textContent = 'Stop Learn';
  if (status) status.textContent = 'Move a knob or press a pad on your MIDI controller... (MIDI must be enabled)';

  setMidiLearnCallback((ev: MidiLearnEvent) => {
    if (ev.value === 0) return; // ignore note-offs / zeroed CCs while learning
    if (!editMappings.some(m => m.kind === ev.kind && m.number === ev.number && m.channel === ev.channel)) {
      editMappings.push({ channel: ev.channel, kind: ev.kind, number: ev.number, target: { type: 'speed' } });
      renderMappingList();
    }
    if (status) status.textContent = `Detected ${ev.kind === 'cc' ? 'CC' : 'Note'} ${ev.number} ch${ev.channel} — added mapping`;
    stopLearn();
  });
}

function stopLearn(): void {
  learnMode = false;
  setMidiLearnCallback(null);
  const btn = document.getElementById('midi-learn-btn');
  if (btn) btn.textContent = 'Learn';
  const status = document.getElementById('midi-learn-status');
  if (status) status.textContent = '';
}
