var fs = require('fs'),
    _ = require('lodash'),
    uuid = require('uuid'),
    connect = require('connect'),
    XXH = require('xxhashjs'),
    httpProxy = require('http-proxy');

var configString = fs.readFileSync('config.json', {encoding: 'utf8'});
var config = JSON.parse(configString);

var headerize = function(key) {
  return 'x-' + key;
}

var setIdentifier = function(req, res, next) {
  if (req.cookies.a) {
    req.userId = req.cookies.a;
  } else {
    req.userId = uuid.v4();
    res.cookie('a', req.userId);
  }

  req.headers['x-user-id'] = req.userId;

  next();
}

var calculateMod = function(layer, userId) {
  return XXH(layer + userId, 0xABCD) % 1000;
}

var getVariant = function(mod, req, experiment) {
  if (req.cookies.forced_variant) {
    if (req.cookies.forced_variant == 'control')
      return null;

    var variant = _.find(experiment.variants, function(variant) {
      return variant.id == req.cookies.forced_variant;
    });

    if (variant)
      return variant;
  }

  if (mod < experiment.startMod)
    return null;

  if (mod > experiment.endMod)
    return null;

  var variantId = mod % (experiment.variants.length + 1);

  if (variantId == 0) {
    return null;
  }

  return experiment.variants[variantId - 1];
}

var isGuarded = function(obj, guard) {
  return _.all(_.pairs(guard), function(pair) {
    if (!obj[pair[0]]) {
      return true;
    }

    if (_.isString(pair[1])) {
      return !obj[pair[0]].match(new RegExp(pair[1]));
    } else {
      return isGuarded(obj[pair[0]], guard[pair[0]]);
    }
  })
}

var setOverrides = function(req, res, next) {
  var userId = req.userId;

  config.layers.forEach(function(layer) {
    var mod = calculateMod(layer.name, userId);

    req.headers['x-' + layer.id + '-mod'] = mod;

    for (var prop in layer.settings) {
      var headerName = headerize(prop);

      req.headers[headerName] = layer.settings[prop];
    }

    layer.experiments.forEach(function(experiment) {
      if (experiment.guard) {
        if (isGuarded(req, experiment.guard)) {
          return;
        }
      }

      var variant = getVariant(mod, req, experiment);

      if (!variant)
        return;

      req.headers['x-' + layer.id + '-' + experiment.id + '-variant'] = variant.id;

      for (var prop in variant.settings) {
        var headerName = headerize(prop);

        req.headers[headerName] = variant.settings[prop];
      }
    });
  });

  next();
}

var proxy = httpProxy.createProxyServer({ target: 'http://' + config.downstream.host + ":" + config.downstream.port });

connect.createServer(
  connect.cookieParser(),
  setIdentifier,
  setOverrides,
  function (req, res) {
    proxy.web(req, res);
  }
).listen(9000);

console.log('Listening on port 9000');
