// Home page library filter. Without JS the box stays hidden and the full list shows.
(() => {
  const box = document.querySelector('.filter');
  const input = document.getElementById('filter');
  const count = document.getElementById('filter-count');
  const empty = document.querySelector('.library + .empty');
  if (!box || !input) return;
  box.hidden = false;
  const hubs = [...document.querySelectorAll('.library .hub')].map((hub) => ({
    hub,
    name: hub.querySelector('h3 a').textContent.toLowerCase(),
    items: [...hub.querySelectorAll('li')].map((li) => ({ li, text: li.textContent.toLowerCase() })),
  }));
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const h of hubs) {
      let any = 0;
      for (const it of h.items) {
        const hay = `${h.name} ${it.text}`;
        const match = words.every((w) => hay.includes(w));
        it.li.hidden = !match;
        if (match) any++;
      }
      h.hub.hidden = any === 0;
      shown += any;
    }
    count.textContent = words.length ? `${shown} ${shown === 1 ? 'script' : 'scripts'}` : '';
    if (empty) empty.hidden = shown > 0;
  });
})();
