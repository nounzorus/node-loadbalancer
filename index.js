var http = require('http');
var fs = require('fs');
var proxy = require('http-proxy');
var request = require('request');

http.globalAgent.maxSockets = 10240;

// Liste des serveurs que l'on souhaite load balancé
var servers = [{
  host: 'ip1',
  port: 80
}, {
  host: 'ip2',
  port: 80
}, {
  host: 'ip3',
  port: 80
}];

var failoverTimer = [];


// Creation d'un objet proxy pour chaque serveur
var proxies = servers.map(function(target) {
  return new proxy.createProxyServer({
    target: target,
    ws: true,
    xfwd: true,
    ssl: false, // TODO ADD SSL
    down: false
  });
});


// Selection d'un serveur

var selectServer = function(req, res) {
  var index = -1;
  var i = 0;

  // On regarde si des cookies sont positionnés (Sticky Session)
  if (req.headers && req.headers.cookie && req.headers.cookie.length > 1) {
    var cookies = req.headers.cookie.split('; ');

    for (i = 0; i < cookies.length; i++) {
      if (cookies[i].indexOf('server=') === 0) {
        var value = cookies[i].substring(7, cookies[i].length);
        if (value && value !== '') {
          index = value;
          break;
        }
      }
    }
  }

  // Si pas de cookie Sticky Session
  // On choisit aléatoirement un serveur
  if (index < 0 ||  !proxies[index]) {
    index = Math.floor(Math.random() * proxies.length);
  }

  // On s'assure que le serveur n'est pas down
  if (proxies[index].options.down) {
    index = -1;

    var tries = 0;
    while (tries < 5 && index < 0) {
      var randomIndex = Math.floor(Math.random() * proxies.length);
      if (!proxies[randomIndex].options.down) {
        index = randomIndex;
      }

      tries++;
    }
  }

  index = index >= 0 ? index : 0;

  // On précise ce serveur en cookie (Sticky Session)
  if (res) {
    res.setHeader('Set-Cookie', 'server=' + index + '; path=/');
  }

  return index;
};

/**
 * Méthode déclenchée en cas d'erreur sur une request
 * Ping le serveur toutes les 10 secondes jusqu'a ce qu'il réponde
 */
var startFailoverTimer = function(index) {
  if (failoverTimer[index]) {
    return;
  }

  failoverTimer[index] = setTimeout(function() {
    // Vérifie si le serveur répond
    request({
      url: 'http://' + proxies[index].options.target.host + ':' + proxies[index].options.target.port,
      method: 'HEAD',
      timeout: 10000
    }, function(err, res, body) {
      failoverTimer[index] = null;

      if (res && res.statusCode === 200) {
        proxies[index].options.down = false;
        console.log('Server #' + index + ' is back up.');
      } else {
        proxies[index].options.down = true;
        startFailoverTimer(index);
        console.log('Server #' + index + ' is still down.');
      }
    });
  }, 10000);

};



// Selectionne le prochain serveur et envoie une requete http
var serverCallback = function(req, res) {
  var proxyIndex = selectServer(req, res);
  var proxy = proxies[proxyIndex];
  proxy.web(req, res);

  proxy.on('error', function(err) {
    startFailoverTimer(proxyIndex);
  });
};
var server = http.createServer(null, serverCallback);

// Récupère le serveur suivant et envoie la requete d'upgrade.
server.on('upgrade', function(req, socket, head) {
  var proxyIndex = selectServer(req);
  var proxy = proxies[proxyIndex];
  proxy.ws(req, socket, head);

  proxy.on('error', function(err, req, socket) {
    socket.end();
    startFailoverTimer(proxyIndex);
  });
});

server.listen(8080, function() {
  console.log("Serveur listening on port 8080");
});
