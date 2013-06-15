/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

"use strict";

var config = {
  username: null,
  password: null
};

var global = this;

var status = (function (window) {
  return {
    show: function (msg) {
      $(".app-status").text(msg).show();
    },
    hide: function (msg) {
      $(".app-status").fadeOut(500);
    }
  };
})(window);

// The local bugzilla database cache.
var db = (function () {
  // We maintain separate databases for anonymous and authenticated access since we
  // get different results.
  function dbname(type){
    return (config.username && config.password) ? ("authenticated-" + type) : type;
  }

  // We cache queries in memory to avoid redundant database lookups.
  var memcache = Object.create(null);
  var counter = 0;

  // Lookup a path in the memory cache.
  function lookup(path, hit, miss) {
    var data = memcache[path];
    data ? hit(data) : miss();
  }

  // Fill the memory cache (and purge it when it gets too large).
  function fill(path, data) {
    if (!data)
      return;
    if (counter >= 100) {
      memcache = Object.create(null);
      counter = 0;
    }
    memcache[path] = data;
    ++counter;
  }

  return {
    get: function (type, key, callback) {
      var path = dbname(type) + "/" + key;
      lookup(path, callback, function () {
        asyncStorage.getItem(dbname(type) + "/" + key, function (data) {
          fill(path, data);
          callback(data);
        });
      });
    },
    set: function (type, key, data, callback) {
      var path = dbname(type) + "/" + key;
      fill(path, data);
      asyncStorage.setItem(dbname(type) + "/" + key, data, callback);
    }
  };
})();

// The bugzilla server.
var bugzilla = (function () {
  // To avoid multiple redundant queries being sent at the same time we queue
  // them and notify everyone waiting for the queue when the result arrives.
  var queue = Object.create(null);

  // Enqueue a pending request. If its the first, execute the fetch callback.
  function enqueue(url, callback, fetch) {
    if (!queue[url]) {
      queue[url] = [];
      fetch(url);
    }
    queue[url].push(callback);
  }

  // Notify anyone waiting for this query.
  function notify(url, data) {
    var list = queue[url];
    delete queue[url];
    for (var n = 0; n < list.length; ++n)
      list[n](data);
  }

  // Execute a query against the bugzilla database
  function query(path, args, callback) {
    var xhr = new XMLHttpRequest();
    if (typeof args === "object") {
      var props = Object.getOwnPropertyNames(args);
      if (props.length != 0) {
        var list = [];
        for (var n = 0; n < props.length; ++n) {
          var name = props[n];
          list.push(escape(name) + "=" + encodeURI(args[name]));
        }
        args = (list.length > 0) ? ("?" + list.join("&")) : "";
      }
    }
    if (typeof args !== "string")
      args = "";
    enqueue("https://api-dev.bugzilla.mozilla.org/latest/" + path + args, callback, function (url) {
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.onreadystatechange = function (e) {
        if (xhr.readyState == 4) {
          if (xhr.status == 200) {
            notify(url, JSON.parse(xhr.responseText));
            return;
          }
          notify(url, null);
        }
      }
      xhr.send(null);
    });
  }

  return {
    // Fetch data from the server.
    fetch: function(type, key, callback) {
      function _(path, args, queryCallback) {
        query(path, args, function (data) {
          if (!data) {
            queryCallback(null);
            return;
          }
          if (data.error && data.code == 300) {
            // Clear username/password and re-do the current fetch.
            config.username = config.password = null;
            fetch(type, key, callback);
            return;
          }
          queryCallback(data);
        });
      }
      var args = {};
      if (config.username && config.password) {
        args.username = config.username;
        args.password = config.password;
      }
      // For comments avoid fetching comments we have already cached, so we have
      // a separate path for that.
      if (type === "comments") {
        db.get(type, key, function (cached) {
          if (cached) {
            var last = cached[cached.length - 1];
            var timestamp = last.creation_time.replace(/^[0-9]/g, "");
            args.new_since = timestamp;
          }
          _("bug/" + key + "/comment", args, function (data) {
            // If we did a partial fetch of comments, append new comments to the
            // already cached comments.
            if (args.new_since)
              data = cached.concat(data);
            callback(data);
          });
        });
        return;
      }
      _(type + "/" + key, args, callback);
    },
    // Check whether a bug has changed since we cached it.
    check: function(bugid, cached, callback) {
      // If we have not cached this bug yet, its different by definition.
      if (!cached) {
        callback(true);
        return;
      }
      query("bug/" + bugid, { include_fields: "last_change_time" }, function (data) {
        if (!data) {
          // Nothing to check if we are offline.
          callback(false);
          return;
        }
        callback(cached.last_change_time != data.last_change_time);
      });
    }
  };
})();

var Bug = {
  Model: (function () {
    function withConfiguration(callback) {
      db.get("configuration", "", function (configuration) {
        // Fetching the configuration is really slow, so we use a cached copy here
        // if we already have one.
        if (configuration) {
          callback(configuration);
          return;
        }
        status.show("Loading configuration, this is slow and a one time thing.");
        bugzilla.fetch("configuration", "", function (configuration) {
          status.hide();
          if (!configuration)
            return;
          db.set("configuration", "", configuration, function () {
            callback(configuration);
          });
        });
      });
    }

    function withBug(bugid, callback) {
      db.get("bug", bugid, function (bug) {
        if (bug)
          callback(bug);
        bugzilla.check(bugid, bug, function (updateNeeded) {
          if (updateNeeded) {
            bugzilla.fetch("bug", bugid, function (bug) {
              callback(bug);
              if (!bug)
                return;
              bugzilla.fetch("comments", bugid, function (comments) {
                if (comments)
                  bug.comments = comments.comments;
                db.set("bug", bugid, bug, function () {
                  callback(bug);
                });
              });
            });
          }
        });
      });
    }

    function link(href, text) {
      return $("<a></a>").attr("href", href).text(text);
    }

    function username(user) {
      return user.real_name ? user.real_name : (user.name ? user.name : "");
    }

    function userlink(user) {
      if (user.name && user.name.indexOf("@") != -1)
        return link("mailto:" + user.name, username(user));
      return username(user);
    }

    function buglink(view, bugid) {
      var link = $("<a></a>").attr("href", "javascript:bug(" + bugid + ")").text(bugid).click(function () {
        view.model.show(bugid);
        return false;
      });
      withBug(bugid, function (bug) {
        if (bug.status === "RESOLVED")
          link.css("text-decoration", "line-through");
      });
      return link;
    }

    function update(view, configuration, bugid, bug) {
      $("*", view).each(function () {
        var source = $(this).data("source");
        if (source) {
          if (source.indexOf("field.") == 0)
            return $(this).text(configuration.field[source.substr(source.indexOf(".")+1)].description + ":");
          if (source.indexOf("bug.") == 0) {
            var value = bug[source.split(".")[1]];
            var format = $(this).data("format");
            switch (format) {
            case "header":
              var header = $(this);
              header.empty();
              link(bugid, "Bug " + bugid).appendTo(header);
              $("<span></span>").text((bug.alias ? (" (" + bug.alias + ")") : "") + " - " + bug.summary).appendTo(header);
              return;
            case "url":
              return $(this).html(link(value, value));
            case "user":
              return $(this).html(userlink(value));
            case "user-list":
              var list = $(this);
              list.empty();
              if (value) {
                $.each(value, function (n, user) {
                  $("<li></li>").text(user.name).appendTo(list);
                });
              }
              return;
            case "bug-list":
              var list = $(this);
              list.empty();
              if (value) {
                $.each(value, function (n, bugid) {
                  $("<li></li>").append(buglink(view, bugid)).appendTo(list);
                });
              }
              return;
            case "timestamp":
              return $(this).text(new Date(value).toLocaleFormat());
            }
            return $(this).text(value);
          }
        }
      });
      var comments = $(".bug .comments");
      comments.empty();
      if (bug.comments) {
        var template = $(".bug > .comment-template");
        $.each(bug.comments, function (n, data) {
          var comment = template.clone();
          $(comment).removeClass("comment-template").addClass("comment");
          $("*", comment).each(function () {
            switch($(this).data("source")) {
            case "comment.text":
              $(this).text(data.text);
              break;
            case "comment.creator":
              $(this).html(userlink(data.creator));
              break;
            };
          });
          comment.appendTo(comments);
        });
      }
      $("*", view).andSelf().show();
    }

    function constructor(view) {
      this.view = view;
    }

    constructor.prototype = {
      show: function (bugid) {
        var view = this.view;
        withConfiguration(function (configuration) {
          withBug(bugid, function(bug) {
            update(view, configuration, bugid, bug);
          });
        });
      }
    }

    return constructor;
  })()
};

$(function () {
  $(".bug").each(function () {
    $("*", this).andSelf().hide();
    this.model = new Bug.Model(this);
    this.model.show(221820);
  });
});

//asyncStorage.clear();
