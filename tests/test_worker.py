import unittest

from unittest.mock import Mock

from webssh.worker import Worker
from tornado.ioloop import IOLoop


class ShortWriteChannel(object):
    """A channel whose send() accepts a scripted number of bytes per call.

    Like paramiko's channel it accepts (unicode) text, and its return value
    is the number of bytes accepted, not the number of characters.
    """

    def __init__(self, accept_sizes):
        self.accept_sizes = list(accept_sizes)
        self.sent = b''

    def send(self, data):
        if isinstance(data, bytes):
            raw = data
        else:
            raw = data.encode('utf-8')
        if self.accept_sizes:
            size = self.accept_sizes.pop(0)
        else:
            size = len(raw)
        size = min(size, len(raw))
        self.sent += raw[:size]
        return size


def make_worker(chan):
    loop = Mock()
    ssh = Mock()
    fake_chan = Mock()
    fake_chan.fileno.return_value = 1
    worker = Worker(loop, ssh, fake_chan, ('127.0.0.1', 22))
    worker.chan = chan
    return worker


class TestWorkerOnWrite(unittest.TestCase):

    def drain(self, worker, extra_messages=None):
        """Drive on_write until the send queue is empty."""
        messages = extra_messages or []
        while worker.data_to_dst:
            worker.on_write()
            if messages:
                worker.data_to_dst.append(messages.pop(0))

    def test_short_write_does_not_drop_multibyte_bytes(self):
        # '你A' encoded as utf-8 is e4 bd a0 41. The channel accepts only
        # one byte on the first send, like the short write reported.
        chan = ShortWriteChannel([1])
        worker = make_worker(chan)
        worker.data_to_dst.append(u'你A')

        self.drain(worker)

        self.assertEqual(chan.sent, u'你A'.encode('utf-8'))
        self.assertEqual(chan.sent.hex(), 'e4bda041')
        self.assertEqual(worker.data_to_dst, [])

    def test_short_write_keeps_following_ascii_intact(self):
        # the bytes after the split multibyte character must survive too
        chan = ShortWriteChannel([2])
        worker = make_worker(chan)
        worker.data_to_dst.append(u'你AB')

        self.drain(worker)

        self.assertEqual(chan.sent, u'你AB'.encode('utf-8'))
        self.assertEqual(chan.sent.hex(), 'e4bda04142')

    def test_several_short_writes(self):
        chan = ShortWriteChannel([1, 1, 1, 1])
        worker = make_worker(chan)
        worker.data_to_dst.append(u'你A')

        self.drain(worker)

        self.assertEqual(chan.sent, u'你A'.encode('utf-8'))

    def test_new_input_arrives_while_bytes_are_pending(self):
        # a short write leaves bytes queued; freshly typed input appended
        # afterwards must be sent as well, without str/bytes join errors
        chan = ShortWriteChannel([1])
        worker = make_worker(chan)
        worker.data_to_dst.append(u'你A')

        worker.on_write()
        self.assertEqual(worker.data_to_dst, [u'你A'.encode('utf-8')[1:]])

        worker.data_to_dst.append(u'B')
        self.drain(worker)

        self.assertEqual(chan.sent, u'你AB'.encode('utf-8'))
        self.assertEqual(worker.data_to_dst, [])

    def test_plain_ascii_still_works(self):
        chan = ShortWriteChannel([3])
        worker = make_worker(chan)
        worker.data_to_dst.append(u'bye')

        self.drain(worker)

        self.assertEqual(chan.sent, b'bye')
        self.assertEqual(worker.data_to_dst, [])


class TestWorkerMode(unittest.TestCase):

    def test_update_handler_switches_to_write_on_short_write(self):
        loop = Mock()
        ssh = Mock()
        fake_chan = Mock()
        fake_chan.fileno.return_value = 1
        worker = Worker(loop, ssh, fake_chan, ('127.0.0.1', 2))
        self.assertEqual(worker.mode, IOLoop.READ)

        worker.update_handler(IOLoop.WRITE)
        loop.update_handler.assert_called_with(1, IOLoop.WRITE)
        self.assertEqual(worker.mode, IOLoop.WRITE)
