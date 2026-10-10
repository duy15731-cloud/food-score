// Food Score settings that change per deployment — kept in ONE place.
// WORKER_URL: our Cloudflare Worker that finds a product picture / name by barcode when the Open*Facts databases
// have none:  GET <WORKER_URL>/product?upc=<code>  ->  {images: [...], title, brand}.
// Empty = switched off: nothing is fetched and products without a database picture show the category emoji.
export const CONFIG = Object.freeze({ WORKER_URL: '' });
