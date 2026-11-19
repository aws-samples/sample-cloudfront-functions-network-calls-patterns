import cf from 'cloudfront';

// Viewer-request function on /patterns/hello-fetch/*.
// GETs /hello on this pattern's origin and copies one JSON field into a request header.
// If the call fails, the request still goes through, with the error in x-hello-error.

const HELLO_ORIGIN_ID = 'hello-fetch';
const HELLO_PATH = '/hello';
const MESSAGE_HEADER = 'x-hello-message';
const STATUS_HEADER = 'x-hello-status';
const ERROR_HEADER = 'x-hello-error';

async function handler(event) {
  const request = event.request;
  // Never pass on viewer-supplied copies of the headers this function sets.
  delete request.headers[MESSAGE_HEADER];
  delete request.headers[STATUS_HEADER];
  delete request.headers[ERROR_HEADER];
  try {
    const helloResponse = await cf.fetch(HELLO_PATH, {
      originId: HELLO_ORIGIN_ID,
      includeBody: true, // default false; needed to read the body
    });
    const text = await helloResponse.text(); // assign first: no await inside call arguments
    const hello = JSON.parse(text);
    request.headers[MESSAGE_HEADER] = { value: String(hello.message) };
    request.headers[STATUS_HEADER] = { value: String(helloResponse.status) };
  } catch (error) {
    // TypeError, TimeoutError, InternalError, or a body that is not JSON.
    request.headers[ERROR_HEADER] = { value: error.name + ': ' + error.message };
  }
  return request;
}
