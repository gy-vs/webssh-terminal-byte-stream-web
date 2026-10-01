import unittest

try:
    from unittest.mock import Mock
except ImportError:
    from mock import Mock

from tornado.ioloop import IOLoop
from webssh.worker import Worker


class ShortWriteChannel(object):
    """Models paramiko.Channel.send in non-blocking mode: it accepts text
    or bytes, reports how many *bytes* the SSH window accepted, and the
    remaining data is the caller's responsibility."""

    def __init__(self, limit=1, encoding='utf-8'):
        self.limit = limit
        self.encoding = encoding
        self.sent = b''
        self.closed = False
        self._fileno = 0

    def fileno(self):
        return self._fileno

    def send(self, data):
        payload = data.encode(self.encoding) if isinstance(data, str) else data
        sent = min(self.limit, len(payload))
        self.sent += payload[:sent]
        return sent

    def close(self):
        self.closed = True


class TestWorkerWrite(unittest.TestCase):

    def make_worker(self, channel):
        worker = Worker(Mock(), Mock(), channel, ('127.0.0.1', 22))
        worker.encoding = channel.encoding
        # don't touch a real ioloop while draining the queue
        worker.update_handler = lambda mode: None
        return worker

    def drain(self, worker):
        """Repeatedly call on_write until the pending data is all sent."""
        while worker.data_to_dst:
            worker.on_write()

    def test_short_write_keeps_multibyte_character_intact(self):
        # '你A' encodes to e4 bd a0 41 in utf-8.  The SSH window accepts
        # only one byte of the first send and reports that back.  Slicing
        # the pending text by that byte count (data[1:]) drops b'bd\xa0',
        # so the remote ends up with e4 41 instead of e4 bd a0 41.
        channel = ShortWriteChannel(limit=1)
        worker = self.make_worker(channel)
        worker.data_to_dst.append(u'你A'.encode('utf-8'))

        worker.on_write()
        self.assertEqual(channel.sent, b'\xe4')
        self.assertTrue(worker.data_to_dst)

        self.drain(worker)
        self.assertEqual(channel.sent, u'你A'.encode('utf-8'))
        self.assertEqual(channel.sent.hex(), 'e4bda041')

    def test_queued_chunks_are_all_flushed(self):
        channel = ShortWriteChannel(limit=1)
        worker = self.make_worker(channel)
        worker.data_to_dst.append(b'\xe4')
        worker.data_to_dst.append(b'\xbd\xa0')
        worker.data_to_dst.append(b'AB')

        self.drain(worker)
        self.assertEqual(channel.sent, b'\xe4\xbd\xa0AB')
        self.assertEqual(worker.data_to_dst, [])

    def test_partial_write_in_the_middle_of_a_character(self):
        # Two-byte window on a three-byte character followed by text:
        # no byte may be skipped and later ascii must not be corrupted.
        channel = ShortWriteChannel(limit=2)
        worker = self.make_worker(channel)
        worker.data_to_dst.append(u'你好Z'.encode('utf-8'))

        self.drain(worker)
        self.assertEqual(channel.sent, u'你好Z'.encode('utf-8'))

    def test_full_write_switch_back_to_read_mode(self):
        channel = ShortWriteChannel(limit=1024)
        worker = self.make_worker(channel)
        modes = []
        worker.update_handler = lambda mode: modes.append(mode)
        worker.data_to_dst.append(u'你A'.encode('utf-8'))

        worker.on_write()
        self.assertEqual(channel.sent, u'你A'.encode('utf-8'))
        self.assertEqual(worker.data_to_dst, [])
        self.assertEqual(modes, [IOLoop.READ])


if __name__ == '__main__':
    unittest.main()
