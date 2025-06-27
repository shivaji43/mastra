import { NetworkContext } from '@/domains/networks';
import React, { createContext, useContext, ReactNode, useState } from 'react';

//the whole workflow execution state.

type StateValue = {
  executionSteps: Array<string>;
  steps: Record<string, any>;
  runId?: string;
};

type State = Record<string, StateValue>;

type VNextNetworkChatContextType = {
  state: State;
  handleStep: (uuid: string, record: Record<string, any>) => void;
  setState: React.Dispatch<React.SetStateAction<State>>;
};

const VNextNetworkChatContext = createContext<VNextNetworkChatContextType | undefined>(undefined);

export const VNextNetworkChatProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<State>({});

  const { chatWithLoop } = useContext(NetworkContext);

  const handleStep = (uuid: string, record: Record<string, any>) => {
    const addFinishStep =
      (chatWithLoop && record.type === 'step-finish' && record.payload?.id === 'final-step') || record.type === 'error';
    let id = record?.type === 'finish' ? 'finish' : record.type === 'start' ? 'start' : record.payload?.id;

    if (id?.includes('mapping_')) return;

    setState(prevState => {
      const current = prevState[uuid];
      if (record.type === 'error') {
        id = current?.executionSteps?.[current?.executionSteps.length - 1];
      }
      const currentMetadata = current?.steps?.[id]?.metadata;

      let startTime = currentMetadata?.startTime;
      let endTime = currentMetadata?.endTime;

      if (record.type === 'step-start') {
        startTime = Date.now();
      }

      if (record.type === 'step-finish' || record.type === 'error') {
        endTime = Date.now();
      }

      return {
        ...prevState,
        [uuid]: {
          ...current,
          runId: current?.runId || record?.payload?.runId,
          executionSteps: current?.steps?.[id]
            ? [...current?.executionSteps, ...(addFinishStep ? ['finish'] : [])]
            : [...(current?.executionSteps || []), id],
          steps: {
            ...current?.steps,
            [id]: {
              ...(current?.steps?.[id] || {}),
              [record.type]: record.payload || record?.error,
              metadata: {
                startTime,
                endTime,
              },
            },
          },
        },
      };
    });
  };

  return (
    <VNextNetworkChatContext.Provider value={{ state, handleStep, setState }}>
      {children}
    </VNextNetworkChatContext.Provider>
  );
};

export const useVNextNetworkChat = () => {
  const context = useContext(VNextNetworkChatContext);
  if (context === undefined) {
    throw new Error('useVNextNetworkChat must be used within a VNextNetworkChatProvider');
  }
  return context;
};
