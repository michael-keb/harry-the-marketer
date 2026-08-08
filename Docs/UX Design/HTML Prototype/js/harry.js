document.querySelectorAll('[data-tabs]').forEach((root) => {
  const tabs = root.querySelectorAll('.tab');
  const panels = root.querySelectorAll('.tab-panel');
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      panels[i]?.classList.add('active');
    });
  });
});

document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.open)?.classList.remove('hidden');
  });
});
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close)?.classList.add('hidden');
  });
});
