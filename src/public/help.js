'use strict';
document.querySelectorAll('.field-help').forEach(group => {
  const button = group.querySelector('.help-trigger');
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  let pinned = false;
  const show = value => {
    panel.hidden = !value;
    button.setAttribute('aria-expanded', String(value));
  };
  group.addEventListener('mouseenter', () => show(true));
  group.addEventListener('mouseleave', () => {
    if (!pinned && !group.contains(document.activeElement)) show(false);
  });
  button.addEventListener('focus', () => show(true));
  button.addEventListener('click', () => {
    pinned = !pinned;
    show(pinned);
  });
  group.addEventListener('focusout', event => {
    if (!pinned && !group.contains(event.relatedTarget)) show(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      pinned = false;
      show(false);
    }
  });
  document.addEventListener('click', event => {
    if (!group.contains(event.target)) {
      pinned = false;
      show(false);
    }
  });
});
