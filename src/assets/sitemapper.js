/**
 * Sitemap Parser
 *
 * Copyright (c) 2020 Sean Thomas Burke
 * Licensed under the MIT license.
 * @author Sean Burke <@seantomburke>
 */

import { parseStringPromise } from "xml2js";
import got from "got";
import zlib from "zlib";
import pLimit from "p-limit";
import isGzip from "is-gzip";

/**
 * @typedef {Object} Sitemapper
 */
export default class Sitemapper {
  /**
   * Construct the Sitemapper class
   *
   * @params {Object} options to set
   * @params {string} [options.url] - the Sitemap url (e.g https://wp.seantburke.com/sitemap.xml)
   * @params {Timeout} [options.timeout] - @see {timeout}
   * @params {boolean} [options.debug] - Enables/Disables additional logging
   * @params {integer} [options.concurrency] - The number of concurrent sitemaps to crawl (e.g. 2 will crawl no more than 2 sitemaps at the same time)
   * @params {integer} [options.retries] - The maximum number of retries to attempt when crawling fails (e.g. 1 for 1 retry, 2 attempts in total)
   * @params {boolean} [options.rejectUnauthorized] - If true (default), it will throw on invalid certificates, such as expired or self-signed ones.
   * @params {lastmod} [options.lastmod] - the minimum lastmod value for urls
   *
   * @example let sitemap = new Sitemapper({
   *   url: 'https://wp.seantburke.com/sitemap.xml',
   *   timeout: 15000,
   *   lastmod: 1630693759
   *  });
   */
  constructor(options) {
    const settings = options || { requestHeaders: {} };
    this.url = settings.url;
    this.timeout = settings.timeout || 15000;
    this.timeoutTable = {};
    this.lastmod = settings.lastmod || 0;
    this.requestHeaders = settings.requestHeaders;
    this.debug = settings.debug;
    this.concurrency = settings.concurrency || 10;
    this.retries = settings.retries || 0;
    this.rejectUnauthorized =
      settings.rejectUnauthorized === false ? false : true;
  }

  async fetch(url = this.url) {
    let results = {
      url: "",
      files: [],
      sites: [],
      errors: [],
    };

    if (this.debug) {
      if (this.lastmod) {
        console.debug(`Using minimum lastmod value of ${this.lastmod}`);
      }
    }

    try {
      results = await this.crawl(url);
    } catch (e) {
      if (this.debug) {
        console.error(e);
      }
    }

    return {
      url,
      files: results.files || [],
      sites: results.sites || [],
      errors: results.errors || [],
    };
  }

  static get timeout() {
    return this.timeout;
  }

  static set timeout(duration) {
    this.timeout = duration;
  }

  static get lastmod() {
    return this.lastmod;
  }

  static set lastmod(timestamp) {
    this.lastmod = timestamp;
  }

  static set url(url) {
    this.url = url;
  }

  static get url() {
    return this.url;
  }

  static set debug(option) {
    this.debug = option;
  }

  static get debug() {
    return this.debug;
  }

  async parse(url = this.url) {
    const requestOptions = {
      method: "GET",
      resolveWithFullResponse: true,
      gzip: true,
      responseType: "buffer",
      headers: this.requestHeaders,
      https: {
        rejectUnauthorized: this.rejectUnauthorized,
      },
    };

    try {
      const requester = got.get(url, requestOptions);

      this.initializeTimeout(url, requester);

      const response = await requester;

      if (!response || response.statusCode !== 200) {
        clearTimeout(this.timeoutTable[url]);
        return { error: response.error, data: response };
      }

      let responseBody;

      if (isGzip(response.rawBody)) {
        responseBody = await this.decompressResponseBody(response.body);
      } else {
        responseBody = response.body;
      }

      const data = await parseStringPromise(responseBody);

      return { error: null, data };
    } catch (error) {
      if (error.name === "CancelError") {
        return {
          error: `Request timed out after ${this.timeout} milliseconds for url: '${url}'`,
          data: error,
        };
      }

      if (error.name === "HTTPError") {
        return {
          error: `HTTP Error occurred: ${error.message}`,
          data: error,
        };
      }

      return {
        error: `Error occurred: ${error.name}`,
        data: error,
      };
    }
  }

  /**
   * Timeouts are necessary for large xml trees. This will cancel the call if the request is taking
   * too long, but will still allow the promises to resolve.
   *
   * @private
   * @param {string} url - url to use as a hash in the timeoutTable
   * @param {Promise} requester - the promise that creates the web request to the url
   */
  initializeTimeout(url, requester) {
    // this will throw a CancelError which will be handled in the parent that calls this method.
    this.timeoutTable[url] = setTimeout(() => requester.cancel(), this.timeout);
  }

  /**
   * Recursive function that will go through a sitemaps tree and get all the sites
   *
   * @private
   * @recursive
   * @param {string} url - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @param {integer} retryIndex - Number of retry attempts fro this URL (e.g. 0 for 1st attempt, 1 for second attempty etc.)
   * @returns {Promise<SitesData>}
   */
  async crawl(url, retryIndex = 0) {
    try {
      const { error, data } = await this.parse(url);
      // The promise resolved, remove the timeout
      clearTimeout(this.timeoutTable[url]);

      if (error) {
        // Handle errors during sitemap parsing / request
        // Retry on error until you reach the retry limit set in the settings
        if (retryIndex < this.retries) {
          if (this.debug) {
            console.log(
              `(Retry attempt: ${retryIndex + 1} / ${
                this.retries
              }) ${url} due to ${data.name} on previous request`
            );
          }
          return this.crawl(url, retryIndex + 1);
        }

        if (this.debug) {
          console.error(
            `Error occurred during "crawl('${url}')":\n\r Error: ${error}`
          );
        }

        return {
          files: [],
          sites: [],
          errors: [
            {
              type: data.name,
              message: error,
              url,
              retries: retryIndex,
            },
          ],
        };
      } else if (data && data.urlset && data.urlset.url) {
        // Handle URLs found inside the sitemap
        if (this.debug) {
          console.debug(`Urlset found during "crawl('${url}')"`);
        }
        // filter out any urls that are older than the lastmod
        const sites = data.urlset.url
          .filter((site) => {
            if (this.lastmod === 0) return true;
            if (site.lastmod === undefined) return false;
            const modified = new Date(site.lastmod[0]).getTime();

            return modified >= this.lastmod;
          })
          .map((site) => site.loc && site.loc[0]);
        return {
          files: [url],
          sites,
          errors: [],
        };
      } else if (data && data.sitemapindex) {
        // Handle child sitemaps found inside the active sitemap
        if (this.debug) {
          console.debug(`Additional sitemap found during "crawl('${url}')"`);
        }
        // Map each child url into a promise to create an array of promises
        const sitemap = data.sitemapindex.sitemap.map(
          (map) => map.loc && map.loc[0]
        );

        // Parse all child urls within the concurrency limit in the settings
        const limit = pLimit(this.concurrency);
        const promiseArray = sitemap.map((site) =>
          limit(() => this.crawl(site))
        );

        // Make sure all the promises resolve then filter and reduce the array
        const results = await Promise.all(promiseArray);
        const sites = results
          .filter((result) => result.errors.length === 0)
          .reduce((prev, { sites }) => [...prev, ...sites], []);
        const errors = results
          .filter((result) => result.errors.length !== 0)
          .reduce((prev, { errors }) => [...prev, ...errors], []);
        const files = results
          .filter((result) => result.files.length !== 0)
          .reduce((prev, { files }) => [...prev, ...files], []);

        return {
          files,
          sites,
          errors,
        };
      }

      // Retry on error until you reach the retry limit set in the settings
      if (retryIndex < this.retries) {
        if (this.debug) {
          console.log(
            `(Retry attempt: ${retryIndex + 1} / ${
              this.retries
            }) ${url} due to ${data.name} on previous request`
          );
        }
        return this.crawl(url, retryIndex + 1);
      }
      if (this.debug) {
        console.error(`Unknown state during "crawl('${url})'":`, error, data);
      }

      // Fail and log error
      return {
        files: [],
        sites: [],
        errors: [
          {
            url,
            type: data.name || "UnknownStateError",
            message: "An unknown error occurred.",
            retries: retryIndex,
          },
        ],
      };
    } catch (e) {
      if (this.debug) {
        this.debug && console.error(e);
      }
    }
  }

  /**
   * Decompress the gzipped response body using zlib.gunzip
   *
   * @param {Buffer} body - body of the gzipped file
   * @returns {Boolean}
   */
  decompressResponseBody(body) {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(body);
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }
}

