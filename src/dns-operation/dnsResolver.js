/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Buffer } from "buffer";
import DNSParserWrap from "./dnsParserWrap.js";
import * as dnsutil from "../helpers/dnsutil.js";
import * as envutil from "../helpers/envutil.js";
import { LocalCache as LocalCache } from "../cache-wrapper/cache-wrapper.js";
import * as util from "../helpers/util.js";

const quad1 = "1.1.1.2";
const ttlGraceSec = 30; // 30s cache extra time
const dnsCacheSize = 10000; // TODO: retrieve this from env?
const httpCacheTtl = 604800; // 1w

export default class DNSResolver {
  constructor() {
    this.dnsParser = new DNSParserWrap();
    this.dnsResCache = null;
    this.httpCache = null;
    this.http2 = null;
    this.nodeUtil = null;
    this.transport = null;
  }

  async lazyInit() {
    if (!this.dnsResCache) {
      this.dnsResCache = new LocalCache("dns-response-cache", dnsCacheSize);
    }
    if (envutil.isWorkers() && !this.httpCache) {
      this.httpCache = caches.default;
    }
    if (envutil.isNode() && !this.http2) {
      this.http2 = await import("http2");
      this.nodeUtil = await import("../helpers/node/util.js");
    }
    if (envutil.isNode() && !this.transport) {
      this.transport = new (
        await import("../helpers/node/dns-transport.js")
      ).Transport(quad1, 53);
    }
  }

  /**
   * @param {Object} param
   * @param {Request} param.request
   * @param {ArrayBuffer} param.requestBodyBuffer
   * @param {String} param.dnsResolverUrl
   * @param {DnsDecodeObject} param.requestDecodedDnsPacket
   * @param {Worker-Event} param.event
   * @param {} param.blocklistFilter
   * @returns
   */
  async RethinkModule(param) {
    await this.lazyInit();
    let response = util.emptyResponse();
    try {
      response.data = await this.resolveRequest(param);
    } catch (e) {
      response = util.errResponse("dnsResolver", e);
      log.e("Err DNSResolver -> RethinkModule", e);
    }
    return response;
  }

  async resolveRequest(param) {
    let cres = await this.resolveFromCache(param);

    if (!cres) {
      // never returns null, may return false
      cres = await this.upstreamQuery(param);
      util.safeBox(() => {
        this.updateCachesIfNeeded(param, cres);
      });
    }

    if (!cres) {
      throw new Error("No answer from cache or upstream", cres);
    }

    return {
      responseBodyBuffer: cres.dnsPacket,
      responseDecodedDnsPacket: cres.decodedDnsPacket,
    };
  }

  /**
   * @param {Object} param
   * @returns
   */
  async resolveFromCache(param) {
    const key = this.cacheKey(param.requestDecodedDnsPacket);
    const qid = param.requestDecodedDnsPacket.id;
    const url = param.request.url;

    if (!key) return null;

    let cacheRes = this.resolveFromLocalCache(qid, key);

    if (!cacheRes) {
      cacheRes = await this.resolveFromHttpCache(qid, url, key);
      this.updateLocalCacheIfNeeded(key, cacheRes);
    }

    return cacheRes;
  }

  resolveFromLocalCache(queryId, key) {
    const cres = this.dnsResCache.Get(key);
    if (!cres) return false; // cache-miss

    return this.makeCacheResponse(queryId, cres.dnsPacket, cres.ttlEndTime);
  }

  async resolveFromHttpCache(queryId, url, key) {
    if (!this.httpCache) return false; // no http-cache

    const hKey = this.httpCacheKey(url, key);
    const resp = await this.httpCache.match(hKey);

    if (!resp) return false; // cache-miss

    const metadata = JSON.parse(resp.headers.get("x-rethink-metadata"));
    const dnsPacket = await resp.arrayBuffer();

    return this.makeCacheResponse(queryId, dnsPacket, metadata.ttlEndTime);
  }

  makeCacheResponse(queryId, dnsPacket, expiry = null) {
    if (expiry !== null && expiry < Date.now()) {
      // stale, expired entry
      log.d("mkcache stale", expiry);
      return false;
    }

    const decodedDnsPacket = util.safeBox(() => {
      return this.dnsParser.Decode(dnsPacket);
    });

    if (!decodedDnsPacket) {
      // can't decode
      log.w("mkcache decode failed", expiry);
      return false;
    }

    if (expiry === null) {
      // new cache entrant
      expiry = this.determineCacheExpiry(decodedDnsPacket);
    }

    let reencode = this.updateTtl(decodedDnsPacket, expiry);
    reencode = this.updateQueryId(decodedDnsPacket, queryId) || reencode;

    const updatedDnsPacket = util.safeBox(() => {
      return reencode ? this.dnsParser.Encode(decodedDnsPacket) : dnsPacket;
    });

    if (!updatedDnsPacket) {
      // can't re-encode
      log.w("mkcache re-encode failed", decodedDnsPacket, expiry);
      return false;
    }

    const cacheRes = {
      dnsPacket: updatedDnsPacket,
      decodedDnsPacket: decodedDnsPacket,
      ttlEndTime: expiry, // may be zero
    };

    return cacheRes;
  }

  async updateCachesIfNeeded(param, cacheRes) {
    if (!cacheRes) return;

    const k = this.cacheKey(param.requestDecodedDnsPacket);
    if (!k) return;

    this.updateLocalCacheIfNeeded(k, cacheRes);
    this.updateHttpCacheIfNeeded(param, k, cacheRes);
  }

  updateLocalCacheIfNeeded(k, v) {
    if (!k || !v) return; // nothing to cache
    if (!v.ttlEndTime) return; // zero ttl

    // strike out redundant decoded packet
    const nv = {
      dnsPacket: v.dnsPacket,
      ttlEndTime: v.ttlEndTime,
    };

    this.dnsResCache.Put(k, nv);
  }

  updateHttpCacheIfNeeded(param, k, cacheRes) {
    if (!this.httpCache) return; // only on Workers
    if (!k || !cacheRes) return; // nothing to cache
    if (!cacheRes.ttlEndTime) return; // zero ttl

    const cacheUrl = this.httpCacheKey(param.request.url, k);
    const value = new Response(cacheRes.dnsPacket, {
      headers: this.httpCacheHeaders(cacheRes, param.blocklistFilter),
    });

    param.event.waitUntil(this.httpCache.put(cacheUrl, value));
  }

  httpCacheHeaders(cres, blFilter) {
    return util.concatHeaders(
      {
        "x-rethink-metadata": JSON.stringify(
          this.httpCacheMetadata(cres, blFilter)
        ),
      },
      util.contentLengthHeader(cres.dnsPacket),
      util.dnsHeaders(),
      { cf: { cacheTtl: httpCacheTtl } }
    );
  }

  /**
   * @param {Object} param
   * @param {Object} cacheRes
   * @param {String} dn
   * @returns
   */
  async upstreamQuery(param) {
    /**
     * @type {Response}
     */
    const upRes = await this.resolveDnsUpstream(
      param.request,
      param.dnsResolverUrl,
      param.requestBodyBuffer
    );

    if (!upRes) throw new Error("no upstream result"); // no answer

    if (!upRes.ok) {
      // serv-fail
      log.d("!OK", upRes.status, upRes.statusText, await upRes.text());
      throw new Error(upRes.status + " http err: " + upRes.statusText);
    }

    const dnsPacket = await upRes.arrayBuffer();

    if (!dnsutil.validResponseSize(dnsPacket)) {
      // invalid answer
      throw new Error("inadequate response from upstream");
    }

    const queryId = param.requestDecodedDnsPacket.id;

    return this.makeCacheResponse(queryId, dnsPacket);
  }

  determineCacheExpiry(decodedDnsPacket) {
    const expiresImmediately = 0; // no caching
    // only noerror ans are cached, that means nxdomain
    // and ans with other rcodes are not cached at all.
    // btw, nxdomain ttls are in the authority section
    if (!dnsutil.rcodeNoError(decodedDnsPacket)) return expiresImmediately;

    // if there are zero answers, there's nothing to cache
    if (!dnsutil.hasAnswers(decodedDnsPacket)) return expiresImmediately;

    // set min(ttl) among all answers, but at least ttlGraceSec
    let minttl = 1 << 30; // some abnormally high ttl
    for (let a of decodedDnsPacket.answers) {
      minttl = Math.min(a.ttl || minttl, minttl);
    }

    if (minttl === 1 << 30) return expiresImmediately;

    minttl = Math.max(minttl + ttlGraceSec, ttlGraceSec);
    const expiry = Date.now() + minttl * 1000;

    return expiry;
  }

  cacheKey(packet) {
    // multiple questions are kind of an undefined behaviour
    // stackoverflow.com/a/55093896
    if (packet.questions.length != 1) return null;

    const name = packet.questions[0].name.trim().toLowerCase();
    const type = packet.questions[0].type;
    return name + ":" + type;
  }

  httpCacheKey(u, p) {
    return new URL(new URL(u).origin + "/" + p);
  }

  updateQueryId(decodedDnsPacket, queryId) {
    if (queryId === 0) return false; // doh reqs are qid free
    if (queryId === decodedDnsPacket.id) return false; // no change
    decodedDnsPacket.id = queryId;
    return true;
  }

  updateTtl(decodedDnsPacket, end) {
    let updated = false;
    const now = Date.now();

    if (end < now) return updated; // negative ttl

    const outttl = Math.max(Math.floor((end - now) / 1000), ttlGraceSec);
    for (let a of decodedDnsPacket.answers) {
      if (dnsutil.optAnswer(a)) continue;
      if (a.ttl === outttl) continue;
      updated = true;
      a.ttl = outttl;
    }

    return updated;
  }
}

function httpCacheMetadata(cacheRes, blFilter) {
  // multiple questions are kind of an undefined behaviour
  // stackoverflow.com/a/55093896
  if (cacheRes.decodedDnsPacket.questions.length !== 1) {
    throw new Error("cache expects just the one dns question");
  }

  const name = cacheRes.decodedDnsPacket.questions[0].name;
  return {
    ttlEndTime: cacheRes.ttlEndTime,
    bodyUsed: true,
    // TODO: Why not store blocklist-info in LocalCache?
    blocklistInfo: util.objOf(blFilter.getDomainInfo(name).searchResult),
  };
}

/**
 * @param {Request} request
 * @param {String} resolverUrl
 * @param {ArrayBuffer} requestBodyBuffer
 * @returns
 */
DNSResolver.prototype.resolveDnsUpstream = async function (
  request,
  resolverUrl,
  requestBodyBuffer
) {
  try {
    // for now, upstream plain-old dns on fly
    if (this.transport) {
      const q = util.bufferOf(requestBodyBuffer);

      let ans = await this.transport.udpquery(q);
      if (ans && dnsutil.truncated(ans)) {
        log.w("ans truncated, retrying over tcp");
        ans = await this.transport.tcpquery(q);
      }

      return ans
        ? new Response(util.arrayBufferOf(ans))
        : new Response(null, { status: 503 });
    }

    let u = new URL(request.url);
    let dnsResolverUrl = new URL(resolverUrl);
    u.hostname = dnsResolverUrl.hostname; // override host, default cloudflare-dns.com
    u.pathname = dnsResolverUrl.pathname; // override path, default /dns-query
    u.port = dnsResolverUrl.port; // override port, default 443
    u.protocol = dnsResolverUrl.protocol; // override proto, default https

    let newRequest = null;
    if (
      request.method === "GET" ||
      (envutil.isWorkers() && request.method === "POST")
    ) {
      u.search = "?dns=" + dnsutil.dnsqurl(requestBodyBuffer);
      newRequest = new Request(u.href, {
        method: "GET",
      });
    } else if (request.method === "POST") {
      newRequest = new Request(u.href, {
        method: "POST",
        headers: util.concatHeaders(
          util.contentLengthHeader(requestBodyBuffer),
          util.dnsHeaders()
        ),
        body: requestBodyBuffer,
      });
    } else {
      throw new Error("get/post requests only");
    }

    return this.http2 ? this.doh2(newRequest) : fetch(newRequest);
  } catch (e) {
    throw e;
  }
};

/**
 * Resolve DNS request using HTTP/2 API of Node.js
 * @param {Request} request - Request object
 * @returns {Promise<Response>}
 */
DNSResolver.prototype.doh2 = async function (request) {
  console.debug("upstream using h2");
  const http2 = this.http2;
  const transformPseudoHeaders = this.nodeUtil.transformPseudoHeaders;

  const u = new URL(request.url);
  const reqB = util.bufferOf(await request.arrayBuffer());
  const headers = util.copyHeaders(request);

  return new Promise((resolve, reject) => {
    // TODO: h2 connection pool
    const authority = u.origin;
    const c = http2.connect(authority);

    c.on("error", (err) => {
      reject(err.message);
    });

    const req = c.request({
      [http2.constants.HTTP2_HEADER_METHOD]: request.method,
      [http2.constants.HTTP2_HEADER_PATH]: `${u.pathname}`,
      ...headers,
    });

    req.on("response", (headers) => {
      const resBuffers = [];
      const resH = transformPseudoHeaders(headers);
      req.on("data", (chunk) => {
        resBuffers.push(chunk);
      });
      req.on("end", () => {
        const resB = Buffer.concat(resBuffers);
        c.close();
        resolve(new Response(resB, resH));
      });
      req.on("error", (err) => {
        reject(err.message);
      });
    });

    req.end(reqB);
  });
};