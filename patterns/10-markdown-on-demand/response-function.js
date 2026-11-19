// Viewer-response function on /patterns/markdown-on-demand/*. No network call.
// An S3 origin echoes nothing, so this copies the x-markdown verdict that function.js left
// on the request onto the response, and adds Vary: the same URL answers HTML or markdown.
// CloudFront skips viewer-response when the origin returns 400 or higher (a missing page).

const VERDICT_HEADERS = ['x-markdown', 'x-markdown-error'];
const VARY = 'Accept, User-Agent'; // Accept, and the user agent Bot Control labels by

async function handler(event) {
  const requestHeaders = event.request.headers;
  const response = event.response;
  VERDICT_HEADERS.forEach((name) => {
    if (requestHeaders[name]) response.headers[name] = { value: requestHeaders[name].value };
  });
  response.headers['vary'] = { value: VARY };
  return response;
}
