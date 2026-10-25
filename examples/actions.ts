// Zyte's own actions (searchKeyword, setLocation, interaction) outside Zyte: handlers that run in
// xyte's browser. See docs/browser.md. The selectors are illustrative.
import { Xyte } from 'xyte';

const xyte = new Xyte({
  actions: {
    // '*' (every other site) stays the built-in heuristic; null turns it off for one site.
    searchKeyword: { 'shop.example': async (page, { keyword }) => page.fill('#find', keyword), 'odd-site.example': null },
    setLocation: {
      'doordash.com': async (page, { address }) => {
        await page.click('[data-anchor-id="AddressButton"]');
        await page.fill('input[aria-label="Address"]', `${address?.streetAddress}, ${address?.postalCode}`);
        await page.click('[data-testid="AddressAutocompleteSuggestion"]');
      },
    },
    interaction: {
      'accept-cookies': async (page) => page.click('#onetrust-accept-btn-handler'),
      'load-all-reviews': async (page, { args }) => {
        for (let i = 0; i < Number(args?.pages ?? 3); i++) await page.click('text=More reviews');
      },
      // Any other script id.
      '*': async (_page, { id }) => {
        throw new Error(`no port of the Zyte script "${id}" yet`);
      },
    },
  },
  unsupportedActions: 'warn',
});

const res = await xyte.extract({
  url: 'https://www.doordash.com/',
  browserHtml: true,
  actions: [
    { action: 'interaction', id: 'accept-cookies', onError: 'continue' },
    { action: 'setLocation', address: { streetAddress: '1 Market St', postalCode: '94105' } },
    { action: 'searchKeyword', keyword: 'pizza' },
  ],
});
console.log(res.actions);
await xyte.close();
