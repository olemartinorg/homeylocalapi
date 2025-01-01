import Homey, { FlowCardTrigger } from 'homey';
import http, { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'node:url';

interface LocalApiRequestState {
  url: string | undefined;
  method: 'get' | 'post';
  id: number;
}

interface LocalApiRequestArgs {
  url: string;
  method: 'get' | 'post' | undefined;
}

interface LocalApiRequestWithBodyArgs extends LocalApiRequestArgs {
  body: string;
}

interface LocalApiRequestWithObjArgs extends LocalApiRequestArgs {
  response: string; // Should contain JSON string with type: { status: number, headers?: Record<string, string>, body?: string }
}

interface LocalApiRequestAdvancedArgs extends LocalApiRequestArgs {
  status: number;
  headers: string;
  body: string;
}

interface LocalApiFlowTokens {
  // All of these are JSON strings. Tokens are defined in `local-api-request-received.json`.
  body: string;
  query: string;
  headers: string;
}

type LocalApiResponse = {
  // This is the response used when returning the simple 'OK' flow card
  type: 'legacy-no-body'; data: { status: 'ok' }; packInObject: true;
} | {
  // Used by the simple response flow card when parsing the response fails
  type: 'legacy-invalid-json'; message: string, error: string | undefined, original: string | undefined; packInObject: true;
} | {
  // used by the simple response flow card when returning a JSON object
  type: 'legacy-json'; data: object; packInObject: true;
} | {
  // Advanced flow cards (v1.2.0+)
  type: 'advanced-response'; status: number; headers?: Record<string, string>; body?: unknown; packInObject: false;
} | {
  // Used by newer advanced response flow cards, when parsing the response fails
  type: 'advanced-error'; message: string; error: string | undefined; packInObject: false;
} | {
  type: 'timeout'; packInObject: false;
};

const FLOW_CARD_CONFLICT = Symbol('FLOW_CARD_CONFLICT');

class LocalApi extends Homey.App {

  TIMEOUT = 30000; // In milliseconds (= 30 seconds)

  idCounter = 0;
  localApiEvent: EventEmitter = new EventEmitter();
  requestReceivedArgs: Array<LocalApiRequestArgs> = [];

  /**
   * Retrieve the CORS config from the settings
   */
  retrieveCorsConfig(): string {
    const corsAcao = this.homey.settings.get('corsAcao') || '*';
    if (corsAcao === '') {
      return '*';
    }
    return corsAcao;
  }

  /**
   * Retrieve CORS active status from the settings
   */
  isCorsActive(): boolean {
    const corsStatus = this.homey.settings.get('corsStatus') || 'false';
    return corsStatus === 'true';
  }

  /**
   * Find the flow card that is supposed to handle this request
   * @param req The node http request object
   */
  findFlowCard(req: IncomingMessage) {
    const flowCards: LocalApiRequestArgs[] = [];
    for (const arg of this.requestReceivedArgs) {
      if (this.isSameUrl(arg.url, req.url)) {
        flowCards.push(arg);
      }
    }

    // If there is only one flow card that matches the request, return it. If there are multiple, figure out
    // if only one matches the method. If there are multiple that match the method, return a special value
    // we can use to indicate a flow card conflict.
    if (flowCards.length === 1) {
      return flowCards[0];
    }

    const method = req.method?.toLowerCase() as 'get' | 'post';
    const matchingMethod = flowCards.filter((card) => card.method === method);
    if (matchingMethod.length === 1) {
      return matchingMethod[0];
    }

    if (matchingMethod.length > 1) {
      return FLOW_CARD_CONFLICT;
    }

    return undefined;
  }

  /**
   * Run listener for the response with 200 action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithOkRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => {
    try {
      const response: LocalApiResponse = { type: 'legacy-no-body', data: { status: 'ok' }, packInObject: true };
      this.localApiEvent.emit(`response/${state.id}`, response);
    } catch (e) {
      this.error(e);
    }
    return true;
  };

  /**
   * Run listener for the response with action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithBodyRunListener = async (args: LocalApiRequestWithBodyArgs, state: LocalApiRequestState) => {
    let response: LocalApiResponse | undefined;
    try {
      response = { type: 'legacy-json', data: JSON.parse(args.body || '{}'), packInObject: true };
    } catch (e) {
      response = {
        type: 'legacy-invalid-json',
        message: 'Invalid JSON',
        error: e instanceof Error ? e.message : undefined,
        original: args.body,
        packInObject: true,
      };
    }
    try {
      this.localApiEvent.emit(`response/${state.id}`, response);
    } catch (e) {
      this.error(e);
    }
    return true;
  };

  isValidStatusCode(statusCode: unknown): statusCode is number {
    return typeof statusCode === 'number' && statusCode >= 100 && statusCode <= 599;
  }

  isValidHeaders(headers: unknown): headers is Record<string, string> {
    if (typeof headers !== 'object' || !headers || Array.isArray(headers)) {
      return false;
    }
    for (const key of Object.keys(headers)) {
      if (!key.match(/^[a-zA-Z]+[a-zA-Z0-9-]+$/)) {
        return false;
      }
      const value = (headers as any)[key];
      if (typeof value !== 'string') {
        return false;
      }
    }
    return true;
  }

  /**
   * Run listener for the response with object action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseWithObjRunListener = async (args: LocalApiRequestWithObjArgs, state: LocalApiRequestState) => {
    let response: LocalApiResponse | undefined;
    try {
      if (!args.response) {
        throw new Error('No response object provided');
      }
      const data = JSON.parse(args.response);
      if (typeof data !== 'object') {
        throw new Error(`Response JSON is not an object (got ${typeof data})`);
      }
      if (!this.isValidStatusCode(data.status)) {
        throw new Error('Response object does not contain a status field, or it is not a valid HTTP status code');
      }
      const headers = data.headers || {};
      if (!this.isValidHeaders(headers)) {
        throw new Error('Invalid headers object (keys must be strings, values must be strings)');
      }
      const body: unknown = data.body || undefined;

      // Detect content-type if not provided in headers:
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }

      response = {
        type: 'advanced-response', status: data.status, headers, body, packInObject: false,
      };
    } catch (e) {
      response = {
        type: 'advanced-error',
        message: 'Invalid response object',
        error: e instanceof Error ? e.message : undefined,
        packInObject: false,
      };
    }
    try {
      this.localApiEvent.emit(`response/${state.id}`, response);
    } catch (e) {
      this.error(e);
    }
    return true;
  };

  /**
   * Run listener for the advanced response action Flow Card
   * @param args The arguments passed to the action card
   * @param state The state of the action card
   */
  responseAdvancedRunListener = async (args: LocalApiRequestAdvancedArgs, state: LocalApiRequestState) => {
    let response: LocalApiResponse | undefined;
    try {
      if (!this.isValidStatusCode(args.status)) {
        throw new Error('Invalid status code');
      }
      const headers = JSON.parse(args.headers?.trim() || '{}');
      let body: unknown = args.body?.trim() || undefined;
      if (!this.isValidHeaders(headers)) {
        throw new Error('Invalid headers object (keys must be strings, values must be strings)');
      }

      // Try to unpack the body as JSON if it is a string, and set the content-type header accordingly if it is not set
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
          if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
          }
        } catch (e) {
          if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'text/plain; charset=utf-8';
          }
        }
      }

      response = {
        type: 'advanced-response', status: args.status, headers, body, packInObject: false,
      };
    } catch (e) {
      response = {
        type: 'advanced-error',
        message: 'Invalid response object',
        error: e instanceof Error ? e.message : undefined,
        packInObject: false,
      };
    }
    try {
      this.localApiEvent.emit(`response/${state.id}`, response);
    } catch (e) {
      this.error(e);
    }
  };

  /**
   * Run listener for the request received Trigger Flow Card
   * @param args The arguments passed to the trigger card
   * @param state The state of the trigger card
   */
  requestReceivedTriggerRunListener = async (args: LocalApiRequestArgs, state: LocalApiRequestState) => (this.isSameUrl(args.url, state.url) && args.method === state.method);

  /**
   * Convert the request query params to a JSON string (with an object of key-value pairs)
   */
  readQueryParams(request: IncomingMessage): string {
    const params = request.url?.split('?', 2)[1];
    const search = new URLSearchParams(params);
    const output: Record<string, unknown> = {};
    for (const key of search.keys()) {
      const all = search.getAll(key);
      output[key] = all.length > 1 ? all : all[0];
    }

    return JSON.stringify(output);
  }

  readHeaders(request: IncomingMessage): string {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = value as string;
    }
    return JSON.stringify(headers);
  }

  isSameUrl(url1: string, url2: string | undefined): boolean {
    return this.sanitizeUrl(url1) === this.sanitizeUrl(url2 || '');
  }

  sanitizeUrl(url: string): string {
    // Trim away query params, trailing, leading and duplicate slashes. We'll be tolerant of misconfigured flow cards,
    // and assume the user meant to include a leading slash in the URL in case they forgot.
    return url.split('?')[0].replace(/\/+/g, '/').replace(/\/$/, '').replace(/^\//, '');
  }

  async handle(req: IncomingMessage, res: ServerResponse, card: FlowCardTrigger, state: LocalApiRequestState, requestBody: string) {
    try {
      const flowTokens: LocalApiFlowTokens = {
        body: requestBody,
        query: this.readQueryParams(req),
        headers: this.readHeaders(req),
      };
      card.trigger(flowTokens, state).then(() => {});

      const response = await this.waitForResponse(state.id);
      this.response(req, res, response);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: e instanceof Error ? e.message : 'Unknown error' }));
      this.error(e);
    } finally {
      this.cleanup(state.id, req, res);
    }
  }

  waitForResponse(id: number): Promise<LocalApiResponse> {
    const successfulOrError = new Promise<LocalApiResponse>((resolve) => {
      this.localApiEvent.once(`response/${id}`, (body: LocalApiResponse) => resolve(body));
    });
    const timeout = new Promise<LocalApiResponse>((resolve) => {
      setTimeout(() => resolve({ type: 'timeout', packInObject: false }), this.TIMEOUT);
    });

    return Promise.race([successfulOrError, timeout]);
  }

  pack(req: IncomingMessage, value: LocalApiResponse): string {
    if (value.packInObject && value.type === 'legacy-invalid-json') {
      // TODO: Figure out if this was actually packed inside a success object in the legacy flow card
      return JSON.stringify({
        status: 'error', message: value.message, error: value.error, original: value.original,
      });
    }
    if (value.packInObject) {
      return JSON.stringify({
        status: 'success', url: req.url, method: req.method, data: value.data,
      });
    }

    throw new Error('Unhandled response type: Only pass responses that should be packed in an object');
  }

  response(req: IncomingMessage, res: ServerResponse, value: LocalApiResponse) {
    switch (value.type) {
      case 'timeout':
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'timeout',
          message: `Timed out after ${(this.TIMEOUT / 1000)} seconds while waiting for a response. `
            + 'Make sure your flow card is not stuck and that every possible error is handled (and also leads to a response).',
        }));
        break;
      case 'legacy-invalid-json':
      case 'legacy-json':
      case 'legacy-no-body':
        // Legacy flow cards always pack their content in a response object and return 200 OK, regardless of
        // the actual status. We keep this behavior for backwards compatibility.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(this.pack(req, value));
        break;
      case 'advanced-response':
        res.writeHead(value.status, value.headers);
        res.end(!value.body || typeof value.body === 'string' ? value.body : JSON.stringify(value.body));
        break;
      case 'advanced-error':
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: value.message, error: value.error }));
        break;
      default: {
        // eslint-disable-next-line no-unused-vars
        const _unused: never = value;
        throw new Error('Unhandled response type');
      }
    }
  }

  cleanup(id: number, request: IncomingMessage, response: ServerResponse): void {
    this.localApiEvent.removeAllListeners(`response/${id}`);
    request.destroy();
    response.destroy();
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // Define Trigger Requests
    const requestReceivedTrigger = this.homey.flow.getTriggerCard('local-api-request-received');
    // Define Actions Responses
    const responseWithBody = this.homey.flow.getActionCard('local-api-response-with');
    const responseWithObj = this.homey.flow.getActionCard('local-api-response-with-obj');
    const responseAdv = this.homey.flow.getActionCard('local-api-response-with-adv');
    const responseWithOk = this.homey.flow.getActionCard('local-api-respond-with-200');
    // Retrieve Settings and initialize Local API App
    const serverPort = this.homey.settings.get('serverPort') || 3000;
    this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues() || [];
    this.localApiEvent.on('warning', (e) => this.error('warning', e.stack));
    this.localApiEvent.on('uncaughtException', (e) => this.error('uncaughtException', e.stack));
    requestReceivedTrigger.registerRunListener(this.requestReceivedTriggerRunListener);
    responseWithBody.registerRunListener(this.responseWithBodyRunListener);
    responseWithObj.registerRunListener(this.responseWithObjRunListener);
    responseAdv.registerRunListener(this.responseAdvancedRunListener);
    responseWithOk.registerRunListener(this.responseWithOkRunListener);
    requestReceivedTrigger.on('update', async () => {
      this.log('LocalAPI: Found updated trigger, updating args... ');
      this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues();
      this.log('LocalAPI: args updated');
    });
    this.log('LocalAPI has been initialized');

    // Create a http server instance that can be used to listening on user defined port (or 3000, default).
    http.createServer(async (req, res) => {
      const id = this.idCounter++;
      const corsAcao = this.retrieveCorsConfig();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', corsAcao);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, Accept, Content-Type, Authorization, Content-Length, X-Requested-With, XMLHttpRequest');

      const flow = this.findFlowCard(req);
      if (!flow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not-found' }));
        return this.cleanup(id, req, res);
      }

      if (flow === FLOW_CARD_CONFLICT) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'conflict', message: 'Multiple flow cards match this request' }));
        return this.cleanup(id, req, res);
      }

      if (flow && req.method === 'OPTIONS' && this.isCorsActive()) {
        // Handle CORS preflight request
        res.writeHead(200);
        res.end();
        return this.cleanup(id, req, res);
      }

      const method = req.method?.toLowerCase() as 'get' | 'post';
      if (flow && method !== flow.method) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'method-not-allowed' }));
        return this.cleanup(id, req, res);
      }

      const state: LocalApiRequestState = { id, url: req.url, method };

      let requestBody = '';
      if (req.method === 'POST') {
        req.on('data', (chunk) => {
          requestBody += chunk;
        });
        req.on('end', async () => {
          await this.handle(req, res, requestReceivedTrigger, state, requestBody);
        });
      } else {
        await this.handle(req, res, requestReceivedTrigger, state, '');
      }

      return undefined; // No cleanup here, that is done in this.handle()
    }).listen(serverPort, () => {
      this.log(`LocalAPI server started at port ${serverPort}`);
    }).on('error', (e:unknown) => {
      // Handle server error
      if (e instanceof Error) {
        if (e.message.includes('EADDRINUSE') || e.message.includes('EACCES')) {
          this.error(`LocalAPI server error: port ${serverPort} already in use`);
        } else {
          this.error(`LocalAPI server error: ${e.message}`);
        }
      } else {
        this.error('LocalAPI server error: unknown error');
      }
    });
  }

}

module.exports = LocalApi;
