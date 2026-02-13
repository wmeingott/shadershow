// =============================================================================
// Context Menu Builder — shared helper for creating positioned context menus.
// Eliminates duplicated DOM creation, positioning, and close-on-click-outside
// logic across showTabContextMenu, showAddTabContextMenu,
// showMixPresetContextMenu, and showVisualPresetContextMenu.
// =============================================================================

let _activeContextMenuId = null;
let _activeClickHandler = null;

// Show a context menu at (x, y) with the given items.
// Each item is either { label, action, disabled? } or { separator: true }.
// menuId: DOM id for the menu element (used for cleanup).
// cleanupFn: optional function called before removing the menu (e.g. to clear external refs).
export function showContextMenu(x, y, items, { menuId = 'tab-context-menu', cleanupFn } = {}) {
  // Remove any existing menu with this id
  hideContextMenu(menuId);

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = menuId;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }

    const el = document.createElement('div');
    el.className = `context-menu-item${item.disabled ? ' disabled' : ''}`;
    el.textContent = item.label;

    if (!item.disabled && item.action) {
      el.addEventListener('click', () => {
        hideContextMenu(menuId);
        item.action();
      });
    }

    menu.appendChild(el);
  }

  // Position
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Adjust if off screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  }

  // Close on click outside
  _activeContextMenuId = menuId;
  _activeClickHandler = (e) => {
    if (!menu.contains(e.target)) {
      hideContextMenu(menuId);
    }
  };
  setTimeout(() => document.addEventListener('click', _activeClickHandler), 0);
}

export function hideContextMenu(menuId = 'tab-context-menu') {
  const menu = document.getElementById(menuId);
  if (menu) menu.remove();
  if (_activeClickHandler && _activeContextMenuId === menuId) {
    document.removeEventListener('click', _activeClickHandler);
    _activeClickHandler = null;
    _activeContextMenuId = null;
  }
}
