// ContextMenu — Shared helper for creating positioned context menus.
// Eliminates duplicated DOM creation, positioning, and close-on-click-outside
// logic across showTabContextMenu, showAddTabContextMenu, etc.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextMenuItem {
  label?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export interface ContextMenuOptions {
  menuId?: string;
  cleanupFn?: () => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _activeContextMenuId: string | null = null;
let _activeClickHandler: ((e: MouseEvent) => void) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  options: ContextMenuOptions = {},
): void {
  const { menuId = 'tab-context-menu' } = options;

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
    el.textContent = item.label || '';

    if (!item.disabled && item.action) {
      el.addEventListener('click', () => {
        hideContextMenu(menuId);
        item.action!();
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
  _activeClickHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      hideContextMenu(menuId);
    }
  };
  setTimeout(() => document.addEventListener('click', _activeClickHandler!), 0);
}

export function hideContextMenu(menuId: string = 'tab-context-menu'): void {
  const menu = document.getElementById(menuId);
  if (menu) menu.remove();
  if (_activeClickHandler && _activeContextMenuId === menuId) {
    document.removeEventListener('click', _activeClickHandler);
    _activeClickHandler = null;
    _activeContextMenuId = null;
  }
}
