# Writes ArtDmx packets built by a third-party sender (stupidArtnet), one per line:
#   <name> <hex>
# Usage: pip install stupidArtnet; python3 gen_artnet.py artnet_packets.txt
import sys
from stupidArtnet import StupidArtnet

out = []
def capture(name, universe, size, values):
    a = StupidArtnet('127.0.0.1', universe, size, 30, True, False)
    got = []
    a.socket_client.close()
    a.socket_client = type('Cap', (), {'sendto': lambda self, data, addr: got.append(bytes(data)), 'close': lambda self: None})()
    a.set(bytearray(values))
    a.show()
    a.close() if hasattr(a, 'close') else None
    out.append(f"{name} {got[-1].hex()}")

capture('dmx_u17', 17, 512, [(i * 7) % 256 for i in range(512)])        # Net 0, Sub-Net 1, Universe 1
capture('dmx_u300', 300, 512, [255 - (i % 256) for i in range(512)])   # Net 1, Sub-Net 2, Universe 12
capture('dmx_u17_short', 17, 24, [200] * 24)                            # only 24 channels
open(sys.argv[1], 'w').write('\n'.join(out) + '\n')
