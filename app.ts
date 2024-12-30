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

interface LocalApiFlowTokens {
  // All of these are JSON strings. Tokens are defined in `local-api-request-received.json`.
  body: string;
  query: string;
  headers: string;
}

type LocalApiResponse = {
  type: 'no-body'; data: { status: 'ok' };
} | {
  type: 'body-json'; data: object;
} | {
  type: 'body-invalid-json'; message: string, error: string | undefined, original: string | undefined;
} | {
  type: 'timeout';
};

const FLOW_CARD_CONFLICT = Symbol('FLOW_CARD_CONFLICT');

class LocalApi extends Homey.App {

  TIMEOUT = 5000; // In milliseconds (= 5 seconds)

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
      const response: LocalApiResponse = { type: 'no-body', data: { status: 'ok' } };
      this.localApiEvent.emit(`responseAction/${state.id}`, response);
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
  responseWithActionRunListener = async (args: LocalApiRequestArgs & { body?: string }, state: LocalApiRequestState) => {
    let response: LocalApiResponse | undefined;
    try {
      response = { type: 'body-json', data: JSON.parse(args.body || '{}') };
    } catch (e) {
      response = {
        type: 'body-invalid-json', message: 'Invalid JSON', error: e instanceof Error ? e.message : undefined, original: args.body,
      };
    }
    try {
      this.localApiEvent.emit(`responseAction/${state.id}`, response);
    } catch (e) {
      this.error(e);
    }
    return true;
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
      if (this.homey.settings.get('rawOutput')) {
        this.rawResponse(res, response);
      } else {
        this.fullResponse(req, res, response);
      }
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
      this.localApiEvent.once(`responseAction/${id}`, (body: LocalApiResponse) => resolve(body));
    });
    const timeout = new Promise<LocalApiResponse>((resolve) => {
      setTimeout(() => resolve({ type: 'timeout' }), this.TIMEOUT);
    });

    return Promise.race([successfulOrError, timeout]);
  }

  /**
   * This handles a a response without packing it into a top-level object (new in v1.2.0)
   */
  rawResponse(res: ServerResponse, value: LocalApiResponse) {
    switch (value.type) {
      case 'timeout': {
        const seconds = this.TIMEOUT / 1000;
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'timeout', message: `Request timed out after ${seconds} seconds` }));
        break;
      }
      case 'no-body': {
        res.writeHead(204); // No content
        res.end();
        break;
      }
      case 'body-invalid-json': {
        // Or maybe we should just return the original string body here? It's not necessarily
        // an error, we could auto-detect the output type and set the content type accordingly.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
        break;
      }
      case 'body-json': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value.data));
        break;
      }
      default: {
        // eslint-disable-next-line no-unused-vars
        const _unused: never = value;
        throw new Error('Unhandled response type');
      }
    }
  }

  /**
   * This handles a response by packing it into a top-level object (default pre v1.2.0)
   */
  fullResponse(req: IncomingMessage, res: ServerResponse, response: LocalApiResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success', url: req.url, method: req.method, data: response,
    }));
  }

  cleanup(id: number, request: IncomingMessage, response: ServerResponse): void {
    this.localApiEvent.removeAllListeners(`responseAction/${id}`);
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
    const responseWithAction = this.homey.flow.getActionCard('local-api-response-with');
    const responseWithOk = this.homey.flow.getActionCard('local-api-respond-with-200');
    // Retrieve Settings and initialize Local API App
    const serverPort = this.homey.settings.get('serverPort') || 3000;
    this.requestReceivedArgs = await requestReceivedTrigger.getArgumentValues() || [];
    this.localApiEvent.on('warning', (e) => this.error('warning', e.stack));
    this.localApiEvent.on('uncaughtException', (e) => this.error('uncaughtException', e.stack));
    requestReceivedTrigger.registerRunListener(this.requestReceivedTriggerRunListener);
    responseWithAction.registerRunListener(this.responseWithActionRunListener);
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
