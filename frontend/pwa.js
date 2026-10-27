(() => {
  const installButton = document.querySelector('#install-app');
  let installPrompt = null;

  const installed = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const hideInstallButton = () => installButton?.classList.add('hidden');

  if (installed()) {
    const splash = document.querySelector('#app-splash');
    splash?.classList.add('is-active');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => {
      splash?.classList.add('is-leaving');
      window.setTimeout(() => splash?.remove(), reduceMotion ? 80 : 650);
    }, reduceMotion ? 120 : 2450);
  }

  if (installButton && !installed()) {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      installPrompt = event;
      installButton.classList.remove('hidden');
    });

    installButton.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const result = await installPrompt.userChoice;
      if (result.outcome === 'accepted') hideInstallButton();
      installPrompt = null;
    });
  }

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    hideInstallButton();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => {
        console.warn('No se pudo activar el modo instalable:', error);
      });
    }, { once: true });
  }
})();
