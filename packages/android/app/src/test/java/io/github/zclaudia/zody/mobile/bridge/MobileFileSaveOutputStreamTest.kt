package io.github.zclaudia.zody.mobile.bridge

import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileFileSaveOutputStreamTest {
    @Test
    fun flushFailureIsReportedAndStreamStillCloses() {
        var closeCalled = false
        val failure = IOException("disk full")
        val output = object : OutputStream() {
            override fun write(value: Int) = Unit
            override fun flush() {
                throw failure
            }
            override fun close() {
                closeCalled = true
            }
        }

        val thrown = assertThrows(IOException::class.java) {
            MobileFileSaveOutputStream(output).finish()
        }

        assertSame(failure, thrown)
        assertTrue("Stream must close even when flushing fails", closeCalled)
    }

    @Test
    fun closeFailureIsReportedAndAbortCanBeRepeated() {
        var closeCalls = 0
        val output = object : OutputStream() {
            override fun write(value: Int) = Unit
            override fun close() {
                closeCalls += 1
                throw IOException("disk full")
            }
        }
        val session = MobileFileSaveOutputStream(output)

        val thrown = assertThrows(IOException::class.java) { session.finish() }
        session.abort()

        assertEquals("disk full", thrown.message)
        assertEquals(1, closeCalls)
    }

    @Test
    fun abortAbsorbsStreamFailureSoOwningSessionCanDeletePartialFile() {
        val output = object : OutputStream() {
            override fun write(value: Int) = Unit
            override fun flush() {
                throw IOException("disk full")
            }
        }

        MobileFileSaveOutputStream(output).abort()
    }
}
