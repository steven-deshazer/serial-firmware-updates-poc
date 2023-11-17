import * as React from 'react';
import { useSerial } from './SerialProvider';
import { Link } from 'react-router-dom';
import { updateCommand_stm32, byteCommandArrayLength } from './serialMessages';
import * as serialMessages from './serialMessages';

const MAX_RETRIES = 3;

const UpdateStatus = {
  Ready: 'ready',
  Awaiting_UpdateCommand_Ack: 'awaitingUpdateCommand_ACK',
  Awaiting_FlashErase_Ack: 'awaitingFlashErase_ACK',
  Awaiting_DataWritten_Ack: 'awaitingDataWritten_ACK',
  Awaiting_DataComplete_Ack: 'awaitingDataComplete_ACK',
  Awaiting_FlashVerification_Ack: 'awaitingFlashVerification_ACK',
  Awaiting_RestartInverter_Ack: 'awaitingRestartInverter_ACK',
  Done: 'done',
  Error: 'error',
};

const Serial = React.memo(function Serial({ firmwareFile }) {
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [percentComplete, setPercentComplete] = React.useState(0);
  const [firmwareUpdateStatus, setFirmwareUpdateStatus] = React.useState(
    UpdateStatus.Ready
  );

  // Use refs to store data that doesn't affect the UI
  // const firmwareFile = React.useRef(new Uint8Array());
  const fileIndex = React.useRef(0);
  const currentCommand = React.useRef(new Uint8Array());
  const expectedResponse = React.useRef(new Uint8Array());
  const timerId = React.useRef(0);
  const timeout = React.useRef(1000);
  const retries = React.useRef(0);

  const serial = useSerial();
  console.log('🚀 ~ file: Serial.jsx:13 ~ Serial ~ serial:', serial);

  React.useEffect(() => {
    console.log('Using effect...');
    return () => {
      if (serial && serial.portState === 'open') {
        console.log('Disconnecting...');
        serial?.disconnect();
      }
    };
  }, [serial]);

  React.useEffect(() => {
    let unsubscribe;
    if (serial.portState === 'open') {
      console.log('Subscribing...');
      unsubscribe = serial.subscribe(handleNewSerialMessage);
    }
    return () => {
      if (unsubscribe) {
        console.log('Unsubscribing...');
        unsubscribe();
      }
    };
  }, [serial]);

  if (!serial.canUseSerial) {
    return (
      <>
        <h1>Serial</h1>
        <p>
          <Link to="/" style={{ color: 'white' }}>
            &lt; Home
          </Link>
        </p>
        <p>Web serial is not supported in this browser.</p>
      </>
    );
  }

  const handleOpenPort = async () => {
    await serial.connect();
  };

  const handleClosePort = () => {
    serial.disconnect();
  };

  const handleTimeout = async () => {
    console.log('Timeout!');
    if (retries.current < MAX_RETRIES) {
      console.log('Retrying...');
      retries.current++;
      await serial.write(currentCommand.current);
      setTimeout(handleTimeout, timeout);
    } else {
      console.log('Too many retries!');
      setFirmwareUpdateStatus(UpdateStatus.Error);
    }
  };

  const handleStartFirmwareUpdate = async () => {
    try {
      setIsUpdating(true);
      setPercentComplete(0);

      if (firmwareFile.current?.length) {
        fileIndex.current = 0;
        setFirmwareUpdateStatus(UpdateStatus.Awaiting_UpdateCommand_Ack);
        expectedResponse.current = serialMessages.updateCommand_Ack;
        currentCommand.current = serialMessages.updateCommand_stm32;
        await serial.write(currentCommand.current);

        timerId.current = setTimeout(handleTimeout, timeout.current);
      }
    } catch (error) {
      console.error(error);
    }
  };

  function getNextDataWriteCommand() {
    const nextDataWriteCommand = new Uint8Array(
      serialMessages.byteCommandArrayLength
    );

    const fileChunkSize = 48;
    // Calculate Offset
    /*
     * Weird math here. For the tms320 file, you need to send a length of 24 (0x18),
     * even though you're sending 48 bytes of data. And then, you need to increment
     * the destination address by 24 with every new packet (not 48).
     *
     * For the stm32 file, you use a length of 48 (0x30) and increment the destination address as expected.
     */
    const nextAddress =
      serialMessages.startAddr_stm32 +
      (fileIndex.current / fileChunkSize) * serialMessages.lengthByte_stm32;
    const nextAddrBytes = new Uint8Array(new Uint32Array([nextAddress]).buffer);

    // Make sure you don't start reading past the end of the file
    const chunkSize =
      firmwareFile.current.length - fileIndex.current >= fileChunkSize
        ? fileChunkSize
        : firmwareFile.current.length - fileIndex.current;

    // Put the 2-byte command and 2-byte length at the beginning
    nextDataWriteCommand.set(serialMessages.commandAndLengthBytes, 0);

    // Then the 4-byte destination address
    nextDataWriteCommand.set(
      nextAddrBytes,
      serialMessages.commandAndLengthBytes.length
    );

    // Then the data from the file
    nextDataWriteCommand.set(
      firmwareFile.current.subarray(
        fileIndex.current,
        fileIndex.current + chunkSize
      ),
      serialMessages.commandAndLengthBytes.length + nextAddrBytes.length
    );

    fileIndex.current += chunkSize;

    return nextDataWriteCommand;
  }

  const handleNewSerialMessage = ({ value, timestamp }) => {
    console.log(
      '🚀 ~ file: Serial.jsx:72 ~ handleNewSerialMessage ~ timestamp:',
      timestamp
    );
    console.log(
      '🚀 ~ file: Serial.jsx:72 ~ handleNewSerialMessage ~ value:',
      value
    );

    //* Let's make a state machine
    if (!expectedResponse.current || !value) return;

    const receivedMessage = value;

    if (
      arraysAreEqual(
        receivedMessage.subarray(0, expectedResponse.current.length),
        expectedResponse.current
      )
    ) {
      // We got the expected response
      clearTimeout(timerId.current);

      switch (firmwareUpdateStatus) {
        case UpdateStatus.Awaiting_UpdateCommand_Ack: {
          setFirmwareUpdateStatus(UpdateStatus.Awaiting_FlashErase_Ack);
          expectedResponse.current = serialMessages.flashEraseCommand_Ack;
          currentCommand.current = serialMessages.flashEraseCommand_stm32;
          serial.write(currentCommand.current);
          timeout.current = 5000;
          setPercentComplete(2);
          break;
        }
        case UpdateStatus.Awaiting_FlashErase_Ack: {
          setFirmwareUpdateStatus(UpdateStatus.Awaiting_DataWritten_Ack);
          expectedResponse.current = serialMessages.dataWritten_Ack;
          currentCommand.current = getNextDataWriteCommand();
          serial.write(currentCommand.current);
          timeout.current = 1000;
          setPercentComplete(5);
          break;
        }
        case UpdateStatus.Awaiting_DataWritten_Ack: {
          if (fileIndex.current < firmwareFile.current.length) {
            expectedResponse.current = serialMessages.dataWritten_Ack;
            currentCommand.current = getNextDataWriteCommand();

            // We arbitrarily assign 92% of the process to transfering the file (from 5%-97%)
            // This take by far the most time of any part of the process
            const percentIncrement = Math.round(
              92.0 * (fileIndex.current / firmwareFile.current.length)
            );
            setPercentComplete(5 + percentIncrement);
          } else {
            // if no more packets, send "data completed" command
            setFirmwareUpdateStatus(UpdateStatus.Awaiting_DataComplete_Ack);
            expectedResponse.current = serialMessages.dataCompleteCommand_Ack;
            currentCommand.current = serialMessages.dataCompleteCommand;
            setPercentComplete(97);
          }

          serial.write(currentCommand.current);
          break;
        }
        case UpdateStatus.Awaiting_DataComplete_Ack: {
          setFirmwareUpdateStatus(UpdateStatus.Awaiting_FlashVerification_Ack);
          expectedResponse.current =
            serialMessages.flashVerificationCommand_Ack;
          currentCommand.current = serialMessages.flashVerificationCommand;
          serial.write(currentCommand.current);
          setPercentComplete(98);
          break;
        }
        case UpdateStatus.Awaiting_FlashVerification_Ack: {
          setFirmwareUpdateStatus(UpdateStatus.Awaiting_RestartInverter_Ack);
          expectedResponse.current = serialMessages.restartInverterCommand_Ack;
          currentCommand.current = serialMessages.restartInverterCommand;
          serial.write(currentCommand.current);
          timeout.current = 3000;
          setPercentComplete(99);
          break;
        }
        case UpdateStatus.Awaiting_RestartInverter_Ack: {
          // We're done!
          setFirmwareUpdateStatus(UpdateStatus.Done);
          setPercentComplete(100);
          break;
        }
        case UpdateStatus.Error:
        case UpdateStatus.Done: {
          console.log(`Current status is ${firmwareUpdateStatus}`);
          break;
        }
        default: {
          console.error(`Unexpected status ${firmwareUpdateStatus}`);
        }
      }
      timerId.current = setTimeout(handleTimeout, timeout.current);
    }
  };

  function arraysAreEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
  }

  return (
    <>
      <h1>Serial</h1>

      <hr />
      {serial.canUseSerial ? (
        <>
          <div>
            <button
              onClick={handleOpenPort}
              disabled={serial.portState !== 'closed'}
            >
              Open Port
            </button>
            <button
              onClick={handleClosePort}
              disabled={serial.portState !== 'open'}
            >
              Close Port
            </button>
            <p>
              COM Port Status: <b>{serial.portState}</b>
            </p>
          </div>
          <hr />
          <div>
            <button onClick={handleStartFirmwareUpdate} disabled={isUpdating}>
              Start Firmware Update
            </button>
            <div>
              <p>Status: {firmwareUpdateStatus}</p>
              <p>Complete: {percentComplete}%</p>
            </div>
          </div>
        </>
      ) : (
        <p>Web serial is not supported in this browser.</p>
      )}
    </>
  );
});

export default Serial;
