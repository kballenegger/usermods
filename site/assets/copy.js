// Copy buttons: <button class="copy" data-copy="<id of the element to copy>">.
document.addEventListener('click', async (event) => {
  const button = event.target instanceof Element ? event.target.closest('button.copy') : null;
  if (!button) return;
  const source = document.getElementById(button.dataset.copy || '');
  if (!source) return;
  await navigator.clipboard.writeText(source.textContent || '');
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});
