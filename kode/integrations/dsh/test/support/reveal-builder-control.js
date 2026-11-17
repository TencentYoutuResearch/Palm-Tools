/** Reveal a Builder control through its visible configuration toggle and summaries. */
export async function revealBuilderControl(page, expression) {
  await page.evaluate(`(async () => {
    const find = () => (${expression});
    let control = find();
    if (!control) throw Error('Builder control is missing');
    const hiddenPanel = control.closest('.kode-builder-configuration[hidden], aside[hidden]');
    if (hiddenPanel) {
      const toggle = Array.from(document.querySelectorAll('.kode-builder-topbar button')).find(button => button.textContent === '配置与预算');
      if (!toggle || toggle.disabled) throw Error('Builder configuration toggle unavailable');
      toggle.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      control = find();
    }
    const ancestors = [];
    for (let node = control.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') ancestors.unshift(node);
    for (const details of ancestors) if (!details.open) {
      const summary = Array.from(details.children).find(node => node.tagName === 'SUMMARY');
      if (!summary || !summary.getClientRects().length) throw Error('Builder section summary is not visible');
      summary.click();
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!control.getClientRects().length || control.closest('[hidden]')) throw Error('Builder control remains hidden');
    control.scrollIntoView({block:'nearest'});
  })()`);
}
