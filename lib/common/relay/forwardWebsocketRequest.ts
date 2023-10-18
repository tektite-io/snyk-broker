import { RequestPayload } from '../types/http';
import { LogContext } from '../types/log';
import { hashToken, maskToken } from '../utils/token';
import { log as logger } from '../../logs/logger';
import { BrokerServerPostResponseHandler } from '../http/downstream-post-stream-to-server';
import { incrementWebSocketRequestsTotal } from '../utils/metrics';
import { ClientOpts } from '../../client/types/client';
import { ServerOpts } from '../../server/types/http';
import { loadFilters } from '../filter/filtersAsync';
import { prepareRequestFromFilterResult } from './prepareRequest';
import {
  makeLegacyRequest,
  makePostStreamingRequest,
  legacyStreaming,
} from './requestsHelper';

export const forwardWebSocketRequest = (
  options: ClientOpts | ServerOpts,
  io?,
) => {
  // 1. Request coming in over websocket conn (logged)
  // 2. Filter for rule match (log and block if no match)
  // 3. Relay over HTTP conn (logged)
  // 4. Get response over HTTP conn (logged)
  // 5. Send response over websocket conn

  //   const filters = Filters(options.filters?.private);
  const filters = loadFilters(options.filters?.private);

  return (brokerToken) => async (payload: RequestPayload, emit) => {
    const requestId = payload.headers['snyk-request-id'];
    const logContext: LogContext = {
      url: payload.url,
      requestMethod: payload.method,
      requestHeaders: payload.headers,
      requestId,
      streamingID: payload.streamingID,
      maskedToken: maskToken(brokerToken),
      hashedToken: hashToken(brokerToken),
      transport: io?.socket?.transport?.name ?? 'unknown',
    };

    if (!requestId) {
      // This should be a warning but older clients won't send one
      // TODO make this a warning when significant majority of clients are on latest version
      logger.trace(
        logContext,
        'Header Snyk-Request-Id not included in headers passed through',
      );
    }

    // It clarifies which emit handler is for websockets vs POST response
    const websocketEmit = emit;

    const postOverrideEmit = (
      responseData,
      isResponseFromRequestModule = false,
    ) => {
      logContext.requestMethod = '';
      logContext.requestHeaders = {};

      const postHandler = new BrokerServerPostResponseHandler(
        logContext,
        options.config,
        brokerToken,
        options.config.serverId,
        requestId,
      );
      if (isResponseFromRequestModule) {
        logger.trace(
          logContext,
          'posting streaming response back to Broker Server',
        );
        postHandler.forwardRequest(responseData, payload.streamingID);
      } else {
        // Only for responses generated internally in the Broker Client/Server
        postHandler.sendData(responseData, payload.streamingID);
      }
    };

    const legacyOverrideEmit = (
      responseData,
      isResponseFromRequestModule = false,
    ) => {
      // Traffic over websockets
      if (payload.streamingID) {
        if (isResponseFromRequestModule) {
          legacyStreaming(
            logContext,
            responseData,
            options.config,
            io,
            payload.streamingID,
          );
        } else {
          io.send('chunk', payload.streamingID, '', false, {
            status: responseData.status,
            headers: responseData.headers,
          });
          io.send(
            'chunk',
            payload.streamingID,
            JSON.stringify(responseData.body),
            true,
          );
        }
      } else {
        logger.trace(
          { ...logContext, responseData },
          'sending fixed response over WebSocket connection',
        );
        websocketEmit(responseData);
      }
    };

    if (io?.capabilities?.includes('receive-post-streams')) {
      // Traffic over HTTP Post
      emit = postOverrideEmit;
    } else {
      emit = legacyOverrideEmit;
    }

    logger.info(logContext, 'received request over websocket connection');

    const filterResponse = filters(payload);
    if (!filterResponse) {
      incrementWebSocketRequestsTotal(true);
      const reason =
        'Response does not match any accept rule, blocking websocket request';
      logContext.error = 'blocked';
      logger.warn(logContext, reason);
      return emit({
        status: 401,
        body: {
          message: 'blocked',
          reason,
          url: payload.url,
        },
      });
    } else {
      const preparedRequest = await prepareRequestFromFilterResult(
        filterResponse,
        payload,
        logContext,
        options,
        brokerToken,
        io?.socketType,
      );
      payload.streamingID
        ? await makePostStreamingRequest(preparedRequest.req, emit, logContext)
        : await makeLegacyRequest(
            preparedRequest.req,
            emit,
            logContext,
            options,
          );
    }
  };
};