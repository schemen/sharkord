import { TRPCClientError } from '@trpc/client';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { logVoice } from '@/helpers/browser-logger';

type TVoiceReconnectFailureContext = {
  transport?: 'producer' | 'consumer';
  state?: string;
  reason?: string;
  error?: unknown;
};

type TUseVoiceReconnectParams = {
  getCurrentChannelId: () => number | null;
  getRouterRtpCapabilities: () => RtpCapabilities | null;
  isUserInCall: boolean;
  isShuttingDown: () => boolean;
  restoreSession: () => Promise<void>;
  onReconnectStart?: () => void;
  onReconnectSuccess?: () => void;
  onReconnectGiveUp?: (reason: string) => void;
  isPermanentFailure?: (error: unknown) => boolean;
};

type TUseVoiceReconnectReturn = {
  isReconnecting: boolean;
  statusText: string;
  attempt: number;
  nextRetryAt: number | null;
  lastFailureReason: string;
  reportTransportFailure: (failure?: TVoiceReconnectFailureContext) => void;
  reportPageVisible: () => void;
  reset: () => void;
};

const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_BACKOFF_MULTIPLIER = 1.5;
const RECONNECT_MAX_DELAY_MS = 64_000;

const getErrorMessage = (error: unknown): string => {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  const trpcError = error as Partial<
    TRPCClientError<unknown> & {
      message?: string;
    }
  >;

  return trpcError.message ?? 'Unknown error';
};

const getFailureReason = (failure?: TVoiceReconnectFailureContext) => {
  if (failure?.reason) {
    return failure.reason;
  }

  if (failure?.error) {
    return getErrorMessage(failure.error);
  }

  return 'Transport failure';
};

const computeDelayMs = (attempt: number): number =>
  Math.random() *
  Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_MULTIPLIER ** (attempt - 1)
  );

const useVoiceReconnect = ({
  getCurrentChannelId,
  getRouterRtpCapabilities,
  isUserInCall,
  isShuttingDown,
  restoreSession,
  onReconnectStart,
  onReconnectSuccess,
  onReconnectGiveUp,
  isPermanentFailure
}: TUseVoiceReconnectParams): TUseVoiceReconnectReturn => {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const [lastFailureReason, setLastFailureReason] = useState('');

  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inProgressRef = useRef(false);
  const isTerminalRef = useRef(false);
  const hiddenFailureReasonRef = useRef<string | null>(null);

  const clearTimer = useCallback(() => {
    if (!reconnectTimerRef.current) {
      return;
    }

    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const canAttemptReconnect = useCallback((): boolean => {
    if (isShuttingDown()) {
      return false;
    }

    const currentChannelId = getCurrentChannelId();
    const hasRouterRtpCapabilities = Boolean(getRouterRtpCapabilities());

    return isUserInCall && Boolean(currentChannelId && hasRouterRtpCapabilities);
  }, [getCurrentChannelId, getRouterRtpCapabilities, isShuttingDown, isUserInCall]);

  const stopReconnect = useCallback(() => {
    clearTimer();

    inProgressRef.current = false;
    isTerminalRef.current = false;
    attemptRef.current = 0;
    hiddenFailureReasonRef.current = null;

    setIsReconnecting(false);
    setStatusText('');
    setAttempt(0);
    setNextRetryAt(null);
    setLastFailureReason('');
  }, [clearTimer]);

  const scheduleReconnect = useCallback(
    (failureReason: string, force: boolean = false) => {
      if (!force && inProgressRef.current) {
        return;
      }

      if (isTerminalRef.current) {
        return;
      }

      if (!canAttemptReconnect()) {
        stopReconnect();
        return;
      }

      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        isUserInCall
      ) {
        const nextAttempt = attemptRef.current + 1;

        hiddenFailureReasonRef.current = failureReason;
        setIsReconnecting(true);
        setStatusText('Reconnect deferred');
        setNextRetryAt(null);
        setAttempt(nextAttempt);
        setLastFailureReason(failureReason);
        logVoice('RECONNECT_DEFERRED', {
          attempt: nextAttempt,
          reason: failureReason
        });

        return;
      }

      const nextAttempt = attemptRef.current + 1;
      attemptRef.current = nextAttempt;

      setAttempt(nextAttempt);
      setLastFailureReason(failureReason);

      if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
        setStatusText('Reconnect failed');
        setIsReconnecting(false);
        setNextRetryAt(null);

        onReconnectGiveUp?.(failureReason);
        isTerminalRef.current = true;
        inProgressRef.current = false;

        logVoice('RECONNECT_GIVEUP', {
          reason: failureReason,
          attempt: nextAttempt
        });

        return;
      }

      onReconnectStart?.();

      const delayMs = computeDelayMs(nextAttempt);
      const nextAttemptAt = Date.now() + delayMs;

      setNextRetryAt(nextAttemptAt);
      setIsReconnecting(true);
      setStatusText(
        `Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${nextAttempt}/${MAX_RECONNECT_ATTEMPTS})`
      );

      logVoice('RECONNECT_ATTEMPT', {
        reason: failureReason,
        attempt: nextAttempt,
        delayMs
      });

      inProgressRef.current = true;

      reconnectTimerRef.current = setTimeout(() => {
        void (async () => {
          if (!canAttemptReconnect()) {
            stopReconnect();
            return;
          }

          setNextRetryAt(null);
          setStatusText(`Reconnecting attempt ${nextAttempt}`);

          logVoice('RECONNECT_ATTEMPT', {
            attempt: nextAttempt,
            channelId: getCurrentChannelId()
          });

          try {
            await restoreSession();

            clearTimer();
            inProgressRef.current = false;

            attemptRef.current = 0;
            hiddenFailureReasonRef.current = null;

            setAttempt(0);
            setStatusText('');
            setLastFailureReason('');
            setNextRetryAt(null);
            setIsReconnecting(false);

            onReconnectSuccess?.();

            logVoice('RECONNECT_SUCCESS', {
              attempt: nextAttempt
            });
          } catch (error) {
            const nextFailureReason = getFailureReason({ error });
            const shouldGiveUp = Boolean(
              isPermanentFailure?.(error) ||
                (error instanceof TRPCClientError
                  ? error.data.code === 'UNAUTHORIZED' ||
                    error.data.code === 'FORBIDDEN'
                  : false)
            );

            inProgressRef.current = false;

            if (shouldGiveUp) {
              clearTimer();
              isTerminalRef.current = true;
              setStatusText('Reconnect required');
              setIsReconnecting(false);
              setNextRetryAt(null);
              setLastFailureReason(nextFailureReason);

              onReconnectGiveUp?.(nextFailureReason);

              logVoice('RECONNECT_GIVEUP', {
                attempt: nextAttempt,
                reason: nextFailureReason
              });

              return;
            }

            if (nextAttempt >= MAX_RECONNECT_ATTEMPTS) {
              isTerminalRef.current = true;
              setStatusText('Reconnect failed');
              setIsReconnecting(false);
              setNextRetryAt(null);
              setLastFailureReason(nextFailureReason);

              onReconnectGiveUp?.(nextFailureReason);

              logVoice('RECONNECT_GIVEUP', {
                attempt: nextAttempt,
                reason: nextFailureReason
              });

              return;
            }

            scheduleReconnect(nextFailureReason, true);

            logVoice('RECONNECT_FAILED', {
              attempt: nextAttempt,
              reason: nextFailureReason,
              nextDelayMs: computeDelayMs(nextAttempt + 1)
            });
          }
        })();
      }, delayMs);
    },
    [
      canAttemptReconnect,
      clearTimer,
      getCurrentChannelId,
      isPermanentFailure,
      isUserInCall,
      onReconnectGiveUp,
      onReconnectSuccess,
      onReconnectStart,
      restoreSession,
      stopReconnect,
    ]
  );

  const reportTransportFailure = useCallback(
    (failure?: TVoiceReconnectFailureContext) => {
    const failureReason = getFailureReason(failure);

    if (!failureReason || !canAttemptReconnect() || inProgressRef.current) {
      return;
    }

    scheduleReconnect(failureReason);
    },
    [canAttemptReconnect, scheduleReconnect]
  );

  const reportPageVisible = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }

    const failureReason = hiddenFailureReasonRef.current;

    if (!failureReason) {
      return;
    }

    hiddenFailureReasonRef.current = null;

    if (!canAttemptReconnect()) {
      return;
    }

    scheduleReconnect(failureReason, true);
  }, [canAttemptReconnect, scheduleReconnect]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const onVisibilityChange = () => {
      if (!document.hidden) {
        reportPageVisible();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [reportPageVisible]);

  useEffect(() => {
    if (isShuttingDown()) {
      stopReconnect();
    }
  }, [isShuttingDown, stopReconnect]);

  useEffect(() => {
    return () => {
      stopReconnect();
    };
  }, [stopReconnect]);

  return {
    isReconnecting,
    statusText,
    attempt,
    nextRetryAt,
    lastFailureReason,
    reportTransportFailure,
    reportPageVisible,
    reset: stopReconnect
  };
};

export { useVoiceReconnect };
