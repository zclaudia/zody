package io.github.zclaudia.zody.mobile.remoteui

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 本地 fake Gateway：只用于 JVM 测试，不访问任何真实服务，也不读取真实凭证。
 */
internal class FakeGatewayServer : AutoCloseable {
    data class RecordedRequest(
        val method: String,
        val path: String,
        val query: String,
        val headers: Map<String, List<String>>,
    ) {
        fun header(name: String): String? =
            headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }
                ?.value
                ?.joinToString(", ")
    }

    val requests = CopyOnWriteArrayList<RecordedRequest>()

    @Volatile
    var responder: (HttpExchange) -> Unit = { exchange ->
        exchange.sendResponseHeaders(404, -1)
    }

    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val executor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "fake-gateway").apply { isDaemon = true }
    }

    init {
        server.executor = executor
        server.createContext("/") { exchange ->
            requests += RecordedRequest(
                method = exchange.requestMethod,
                path = exchange.requestURI.rawPath,
                query = exchange.requestURI.rawQuery ?: "",
                headers = exchange.requestHeaders.entries.associate {
                    it.key.lowercase(Locale.ROOT) to it.value.toList()
                },
            )
            try {
                responder(exchange)
            } catch (_: IOException) {
                // 客户端超时/断开时 fake server 写入失败是预期行为，测试不关心。
            } finally {
                exchange.close()
            }
        }
        server.start()
    }

    val baseUrl: String
        get() = "http://127.0.0.1:${server.address.port}"

    fun reset() {
        requests.clear()
    }

    fun requestCount(): Int = requests.size

    override fun close() {
        server.stop(0)
        executor.shutdownNow()
        executor.awaitTermination(1, TimeUnit.SECONDS)
    }
}

internal fun respond(
    exchange: HttpExchange,
    status: Int,
    body: ByteArray = ByteArray(0),
    headers: Map<String, String> = emptyMap(),
    delayMillis: Long = 0,
    chunked: Boolean = false,
    contentLengthOverride: Long? = null,
) {
    if (delayMillis > 0) {
        Thread.sleep(delayMillis)
    }
    for ((name, value) in headers) {
        exchange.responseHeaders.add(name, value)
    }
    val isHead = exchange.requestMethod.equals("HEAD", ignoreCase = true)
    if (chunked && !isHead) {
        exchange.sendResponseHeaders(status, 0)
        exchange.responseBody.write(body)
        exchange.responseBody.flush()
        return
    }
    val length = contentLengthOverride ?: when {
        status == 204 || status in 300..399 || isHead -> -1L
        else -> body.size.toLong()
    }
    exchange.sendResponseHeaders(status, length)
    if (!isHead && length >= 0) {
        exchange.responseBody.write(body)
        exchange.responseBody.flush()
    }
}
