"""Local OpenBCI -> authenticated Cortex² ingest. Keeps Bluetooth/USB on your laptop.
Usage: CORTEX_API=https://... CORTEX_INGEST_TOKEN=... python openbci.py --board synthetic
For actual OpenBCI boards use the correct board name and serial port.
"""
import argparse
import os
import time
import numpy as np
import requests
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
from brainflow.data_filter import DataFilter, FilterTypes, WindowOperations

BOARD_IDS={"synthetic":BoardIds.SYNTHETIC_BOARD.value,
           "cyton":BoardIds.CYTON_BOARD.value,
           "cyton-daisy":BoardIds.CYTON_DAISY_BOARD.value,
           "ganglion":BoardIds.GANGLION_BOARD.value}
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--board",choices=BOARD_IDS,default="synthetic")
    parser.add_argument("--serial-port",default="")
    parser.add_argument("--mac-address",default="")
    parser.add_argument("--channel",type=int,default=0)
    args=parser.parse_args()
    url=os.environ["CORTEX_API"].rstrip("/")+"/v1/eeg/ingest"
    token=os.environ["CORTEX_INGEST_TOKEN"]
    params=BrainFlowInputParams()
    params.serial_port=args.serial_port
    params.mac_address=args.mac_address
    board_id=BOARD_IDS[args.board]
    board=BoardShim(board_id,params)
    board.prepare_session()
    board.start_stream()
    hz=BoardShim.get_sampling_rate(board_id)
    channels=BoardShim.get_eeg_channels(board_id)
    if args.channel>=len(channels):raise ValueError("requested channel is not present")
    print(f"streaming {args.board} at {hz} hz")
    try:
        while True:
            time.sleep(.5)
            data=board.get_current_board_data(max(int(hz*3),256))
            if data.size==0:continue
            raw=np.asarray(data[channels[args.channel]],dtype=float)
            if len(raw)<int(hz):continue
            window=raw[-int(hz*2):] if len(raw)>=int(hz*2) else raw
            centered=window-np.mean(window)
            # FFT band power estimates for visualization, not clinical EEG interpretation.
            spectrum=np.abs(np.fft.rfft(centered*np.hanning(len(centered))))**2
            freqs=np.fft.rfftfreq(len(centered),d=1/hz)
            def p(lo,hi):return float(np.sum(spectrum[(freqs>=lo)&(freqs<hi)]))
            band=np.asarray([p(.5,4),p(4,8),p(8,13),p(13,30)])
            total=max(1e-10,float(band.sum()))
            pct=100*band/total
            samples=np.clip(centered[-130:],-5000,5000).tolist()
            response=requests.post(url,json={"channel":f"{args.board}:{args.channel}",
                "delta":float(pct[0]),"theta":float(pct[1]),"alpha":float(pct[2]),
                "beta":float(pct[3]),"quality":"unverified raw eeg","samples":samples},
                headers={"Authorization":f"Bearer {token}"},timeout=12)
            response.raise_for_status()
    finally:
        board.stop_stream()
        board.release_session()
if __name__=="__main__":main()
