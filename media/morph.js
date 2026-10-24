// @ts-check
// Tiny DOM patcher: updates only what changed, so re-rendering does not flicker,
// restart animations or reset CSS transitions (bars slide instead of jumping).
(function () {
  /** @param {Element} from @param {Element} to */
  function syncAttrs(from, to) {
    for (const { name } of Array.from(from.attributes)) {
      if (!to.hasAttribute(name)) from.removeAttribute(name);
    }
    for (const { name, value } of Array.from(to.attributes)) {
      if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    }
  }

  /** @param {Node} n */
  const keyOf = (n) => (n instanceof Element ? n.getAttribute('data-key') : null);

  /** @param {Node} from @param {Node} to */
  function patchChildren(from, to) {
    const a = Array.from(from.childNodes);
    const b = Array.from(to.childNodes);
    b.forEach((next, i) => {
      const cur = a[i];
      if (!cur) {
        from.appendChild(next);
      } else if (cur.nodeType !== next.nodeType || cur.nodeName !== next.nodeName || keyOf(cur) !== keyOf(next)) {
        from.replaceChild(next, cur);
      } else if (cur.nodeType === Node.TEXT_NODE || cur.nodeType === Node.COMMENT_NODE) {
        if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
      } else if (cur instanceof Element && next instanceof Element) {
        syncAttrs(cur, next);
        patchChildren(cur, next);
        if (cur instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
          const selected = next.querySelector('option[selected]');
          if (selected) cur.value = /** @type {HTMLOptionElement} */ (selected).value;
        }
      }
    });
    for (let i = b.length; i < a.length; i++) from.removeChild(a[i]);
  }

  /** @param {HTMLElement} container @param {string} html */
  function morph(container, html) {
    const next = document.createElement(container.tagName);
    next.innerHTML = html;
    patchChildren(container, next);
  }

  // The entrance animation only plays on the first paint.
  setTimeout(() => document.body.classList.remove('intro'), 900);

  /** @type {any} */ (window).morph = morph;
})();
