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
  /** Nested items rendered as a hover submenu (▶). */
  submenu?: ContextMenuItem[];
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

  const appendItems = (container: HTMLElement, list: ContextMenuItem[]): void => {
    for (const item of list) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        container.appendChild(sep);
        continue;
      }

      const el = document.createElement('div');
      el.className = `context-menu-item${item.disabled ? ' disabled' : ''}`;
      el.textContent = item.label || '';

      if (item.submenu) {
        el.classList.add('has-submenu');
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.textContent = '▶';
        el.appendChild(arrow);

        const sub = document.createElement('div');
        sub.className = 'context-submenu';
        appendItems(sub, item.submenu);
        el.appendChild(sub);
      } else if (!item.disabled && item.action) {
        el.addEventListener('click', () => {
          hideContextMenu(menuId);
          item.action!();
        });
      }

      container.appendChild(el);
    }
  };
  appendItems(menu, items);

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
    menu.style.top = `${Math.max(5, window.innerHeight - rect.height - 5)}px`;
    // If menu is taller than viewport, make it scrollable
    if (rect.height > window.innerHeight - 10) {
      menu.style.maxHeight = `${window.innerHeight - 10}px`;
      menu.style.overflowY = 'auto';
    }
  }

  // Reposition submenus on hover to stay within viewport
  menu.querySelectorAll('.has-submenu').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const sub = item.querySelector('.context-submenu') as HTMLElement | null;
      if (!sub) return;
      // Reset positioning before measuring
      sub.style.left = '100%';
      sub.style.right = '';
      sub.style.top = '-4px';
      sub.style.maxHeight = '';
      sub.style.overflowY = '';

      const subRect = sub.getBoundingClientRect();
      // Flip to left side if overflowing right
      if (subRect.right > window.innerWidth) {
        sub.style.left = '';
        sub.style.right = '100%';
      }
      // Shift up if overflowing bottom
      if (subRect.bottom > window.innerHeight) {
        const shift = subRect.bottom - window.innerHeight + 5;
        sub.style.top = `${-4 - shift}px`;
      }
      // Make scrollable if taller than viewport
      if (subRect.height > window.innerHeight - 10) {
        sub.style.maxHeight = `${window.innerHeight - 10}px`;
        sub.style.overflowY = 'auto';
      }
    });
  });

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
