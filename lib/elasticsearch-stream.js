/**
 * Elasticsearch Stream
 *
 * Create a ReadableStream from an elasticsearch scroll query.
 * Assumptions: client library is of type [elasticsearch](https://www.npmjs.org/package/elasticsearch)
 */
var Readable = require('stream').Readable,
  util = require('util')

/**
 * LibElasticsearchScrollStream
 *
 * @param `client` - elasticsearch instance
 * @param `query_opts` - query object to be passed to elasticsearch.
 *        It contains the query
 * @param `optional_fields` - array of optional properties to include in the results.
 *        Allowed values: '_id', '_score', '_type', '_index', '_parent', '_routing'
 * @param `stream_opts` - object to be passed to ReadableStream
 */
var LibElasticsearchScrollStream = function(client, query_opts, optional_fields, stream_opts) {
  this._client = client
  this._options = query_opts
  this._extrafields = optional_fields
  this._options.scroll = query_opts.scroll || '10m'
  this._reading = false
  this._counter = 0
  this._total = 0
  this._forceClose = false
  Readable.call(this, stream_opts)
}

util.inherits(LibElasticsearchScrollStream, Readable)

LibElasticsearchScrollStream.prototype._read = function() {
  if (this._reading) {
    return false
  }

  this._reading = true
  var self = this
  this._client.search(this._options, function getMoreUntilDone(err, response) {
    if (err) {
      return self.emit('error', err)
    }

    // Set the total matching documents
    // For Elasticsearch greater then 7.x hits.total is an object:
    //    {
    //       value: 20,
    //       relation: "eq"
    //    }
    var body = !!response.body ? response.body : response
    self._total = typeof body.hits.total === 'object' ? body.hits.total.value : body.hits.total
    var objectMode = self._readableState.objectMode

    if (body.timedOut) {
      return self.emit('error', {
        message: 'Scroll request timed out',
        timedOut: true,
        total: self._total,
        counter: self._counter
      })
    }

    if (body._shards.failed > 0) {
      return self.emit('error', {
        message: 'At least one shard failed',
        shards: body._shards,
        total: self._total,
        counter: self._counter
      })
    }

    if (body.hits.hits.length === 0) {
      var missingObjects = self._total - self._counter
      var message = 'No more hits. Expected ' + missingObjects + ' more objects. Closing stream.';
      console.log('Read 0 (' + self._counter + '/' + self._total + ')')

      return self.emit('error', {
        message,
        total: self._total,
        counter: self._counter,
        missing: missingObjects
      })
    }

    body.hits.hits.forEach(function(hit) {
      var ref_results = {}
      if (hit.fields) {
        ref_results = hit.fields
      } else {
        ref_results = hit._source
      }

      // populate extra fields
      self._extrafields.forEach(function(entry) {
        ref_results[entry] = hit[entry]
      })

      self.push(objectMode ? ref_results : JSON.stringify(ref_results))
      self._counter++
    })

	  console.log('Read ' + body.hits.hits.length + ' (' + self._counter + '/' + self._total + ')')

    if (self._total !== self._counter && !self._forceClose) {
      self._client.scroll(
        {
          scroll: self._options.scroll,
          scroll_id: body._scroll_id,
        },
        getMoreUntilDone
      )
    } else {
      // clearScroll for the current _scroll_id
      self._client.clearScroll({ scrollId: [body._scroll_id] }, function(err, res) {
	      if (err) {
		      console.error(err)
	      }
        // end correctly
        return setImmediate(function() {
          self._reading = false
          self._counter = 0
          self._forceClose = false
          self.push(null)
        })
      })
    }
  })
}

LibElasticsearchScrollStream.prototype.close = function() {
  return (this._forceClose = true)
}

module.exports = LibElasticsearchScrollStream
