'use strict'

var helper = require('../../lib/agent_helper')
var tap = require('tap')
var semver = require('semver')


tap.test('external requests', function(t) {
  t.autoend()

  t.test('segments should end on error', function(t) {
    var agent = helper.loadTestAgent(t)
    var http = require('http')

    var notVeryReliable = http.createServer(function badHandler(req) {
      req.socket.end()
    })

    notVeryReliable.listen(0)

    helper.runInTransaction(agent, function inTransaction() {
      var req = http.get(notVeryReliable.address())

      req.on('error', function onError() {
        var segment = agent.tracer.getTransaction().trace.root.children[0]

        t.equal(
          segment.name,
          'External/localhost:' + notVeryReliable.address().port + '/',
          'should be named'
        )
        t.ok(segment.timer.start, 'should have started')
        t.ok(segment.timer.hasEnd(), 'should have ended')

        notVeryReliable.close(function closed() {
          t.end()
        })
      })
    })
  })

  t.test('should have expected child segments', function(t) {
    // The externals segment is based on the lifetime of the request and response.
    // These objects are event emitters and we consider the external to be
    // completed when the response emits `end`. Since there are actions that
    // happen throughout the requests lifetime on other events, each of those
    // sequences will be their own tree under the main external call. This
    // results in a tree with several sibling branches that might otherwise be
    // shown in a heirarchy. This is okay.
    var agent = helper.loadTestAgent(t)
    var http = require('http')

    var server = http.createServer(function(req, res) {
      req.resume()
      res.end('ok')
    })
    t.tearDown(function() {
      server.close()
    })

    server.listen(0)

    helper.runInTransaction(agent, function inTransaction(tx) {
      var url = 'http://localhost:' + server.address().port + '/some/path'
      http.get(url, function onResonse(res) {
        res.resume()
        res.once('end', function resEnded() {
          setTimeout(function timeout() {
            check(tx)
          }, 10)
        })
      })
    })

    function check(tx) {
      var external = tx.trace.root.children[0]
      t.equal(
        external.name,
        'External/localhost:' + server.address().port + '/some/path',
        'should be named as an external'
      )
      t.ok(external.timer.start, 'should have started')
      t.ok(external.timer.hasEnd(), 'should have ended')
      t.ok(external.children.length, 'should have children')

      // TODO: Change this to a simple equal when deprecating Node v0.10
      var connect = external.children[0]
      t.match(
        connect.name,
        /^(?:http\.Agent#createConnection|net\.Socket\.connect)$/,
        'should be connect segment'
      )
      t.equal(connect.children.length, 1, 'connect should have 1 child')

      // There is potentially an extra layer of create/connect segments.
      if (connect.children[0].name === 'net.Socket.connect') {
        connect = connect.children[0]
      }

      var dnsLookup = connect.children[0]
      t.equal(dnsLookup.name, 'dns.lookup', 'should be dns.lookup segment')

      var callback = external.children[external.children.length - 1]
      t.equal(callback.name, 'timers.setTimeout', 'should have timeout segment')

      t.end()
    }
  })

  t.test('should not duplicate the external segment', function(t) {
    var agent = helper.loadTestAgent(t)
    var https = require('https')

    helper.runInTransaction(agent, function inTransaction() {
      https.get('https://encrypted.google.com/', function onResonse(res) {
        res.once('end', check)
        res.resume()
      })
    })

    function check() {
      var root = agent.tracer.getTransaction().trace.root
      var segment = root.children[0]

      t.equal(
        segment.name,
        'External/encrypted.google.com/',
        'should be named'
      )
      t.ok(segment.timer.start, 'should have started')
      t.ok(segment.timer.hasEnd(), 'should have ended')
      t.equal(segment.children.length, 1, 'should have 1 child')

      var notDuped = segment.children[0]
      t.notEqual(
        notDuped.name,
        segment.name,
        'child should not be named the same as the external segment'
      )

      t.end()
    }
  })

  // TODO: Remove the skip after deprecating Node <6.
  var gotOpts = {
    timeout: 5000,
    skip: semver.satisfies(process.version, '<4 || 5')
  }
  t.test('NODE-1647 should not interfere with `got`', gotOpts, function(t) {
    // Our way of wrapping HTTP response objects caused `got` to hang. This was
    // resolved in agent 2.5.1.
    var agent = helper.loadTestAgent(t)
    var got = require('got')
    helper.runInTransaction(agent, function() {
      var req = got('https://www.google.com/')
      t.tearDown(function() { req.cancel() })
      req.then(
        function() { t.end() },
        function(e) { t.error(e); t.end() }
      )
    })
  })
})
