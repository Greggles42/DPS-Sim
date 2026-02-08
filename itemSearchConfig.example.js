/**
 * Item search API config (copy to itemSearchConfig.js and set your API key).
 * itemSearchConfig.js is gitignored so your key is not committed.
 */
if (typeof ItemSearch !== 'undefined') {
  ItemSearch.setConfig({
    baseUrl: 'https://dndquarm.com/api/QuarmData/items/search',
    apiKey: 'YOUR_API_KEY_HERE'
  });
}
