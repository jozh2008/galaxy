
define([
    "mvc/history/history-contents",
    "mvc/base/controlled-fetch-collection",
    "utils/utils",
    "mvc/base-mvc",
    "utils/localization"
], function( HISTORY_CONTENTS, CONTROLLED_FETCH_COLLECTION, UTILS, BASE_MVC, _l ){
'use strict';

//==============================================================================
/** @class Model for a Galaxy history resource - both a record of user
 *      tool use and a collection of the datasets those tools produced.
 *  @name History
 *  @augments Backbone.Model
 */
var History = Backbone.Model
        .extend( BASE_MVC.LoggableMixin )
        .extend( BASE_MVC.mixin( BASE_MVC.SearchableModelMixin, /** @lends History.prototype */{
    _logNamespace : 'history',

    /** ms between fetches when checking running jobs/datasets for updates */
    UPDATE_DELAY : 4000,

    // values from api (may need more)
    defaults : {
        model_class     : 'History',
        id              : null,
        name            : 'Unnamed History',
        state           : 'new',

        deleted         : false,
        contents_shown  : {},
    },

    urlRoot: Galaxy.root + 'api/histories',

    // ........................................................................ set up/tear down
    /** Set up the model
     *  @param {Object} historyJSON model data for this History
     *  @param {Object[]} contentsJSON   array of model data for this History's contents (hdas or collections)
     *  @param {Object} options     any extra settings including logger
     */
    initialize : function( historyJSON, contentsJSON, options ){
        options = options || {};
        this.logger = options.logger || null;
        this.log( this + ".initialize:", historyJSON, contentsJSON, options );

        /** HistoryContents collection of the HDAs contained in this history. */
        this.log( 'creating history contents:', contentsJSON );
        this.contents = new HISTORY_CONTENTS.HistoryContents( contentsJSON || [], { historyId: this.get( 'id' )});

        this._setUpListeners();
        this._setUpCollectionListeners();

        /** cached timeout id for the dataset updater */
        this.updateTimeoutId = null;
    },

    /** set up any event listeners for this history including those to the contained HDAs
     *  events: error:contents  if an error occurred with the contents collection
     */
    _setUpListeners : function(){
        // if the model's id changes ('current' or null -> an actual id), update the contents history_id
        return this.on({
            'error' : function( model, xhr, options, msg, details ){
                this.clearUpdateTimeout();
            },
            'change:id' : function( model, newId ){
                if( this.contents ){
                    this.contents.historyId = newId;
                }
            },
        });
    },

    /**  */
    _setUpCollectionListeners : function(){
        if( !this.contents ){ return this; }
        // bubble up errors
        return this.listenTo( this.contents, {
            'error' : function(){
                this.trigger.apply( this, jQuery.makeArray( arguments ) );
            },
        });
    },

    // ........................................................................ derived attributes
    /** convert size in bytes to a more human readable version */
    nice_size : function(){
        return UTILS.bytesToString( this.get( 'size' ), true, 2 );
    },

    /** override to add nice_size */
    toJSON : function(){
        return _.extend( Backbone.Model.prototype.toJSON.call( this ), {
            nice_size : this.nice_size()
        });
    },

    /** override to allow getting nice_size */
    get : function( key ){
        if( key === 'nice_size' ){
            return this.nice_size();
        }
        return Backbone.Model.prototype.get.apply( this, arguments );
    },

    // ........................................................................ common queries
    /** T/F is this history owned by the current user (Galaxy.user)
     *      Note: that this will return false for an anon user even if the history is theirs.
     */
    ownedByCurrUser : function(){
        // no currUser
        if( !Galaxy || !Galaxy.user ){
            return false;
        }
        // user is anon or history isn't owned
        if( Galaxy.user.isAnonymous() || Galaxy.user.id !== this.get( 'user_id' ) ){
            return false;
        }
        return true;
    },

    /** Return the number of running jobs assoc with this history (note: unknown === 0) */
    numOfUnfinishedJobs : function(){
        var unfinishedJobIds = this.get( 'non_ready_jobs' );
        return unfinishedJobIds? unfinishedJobIds.length : 0;
    },

    /** Return the number of running hda/hdcas in this history (note: unknown === 0) */
    numOfUnfinishedShownContents : function(){
        var contents = this.contents.running().visibleAndUndeleted();
        return contents? contents.length : 0;
    },

    // ........................................................................ search
    /** What model fields to search with */
    searchAttributes : [
        'name', 'annotation', 'tags'
    ],

    /** Adding title and singular tag */
    searchAliases : {
        title       : 'name',
        tag         : 'tags'
    },

    // ........................................................................ updates
    _getSizeAndRunning : function(){
        return this.fetch({ data : $.param({ keys : 'size,non_ready_jobs' }) });
    },

    /**  */
    refresh : function( options ){
        options = options || {};
        var self = this;

        // note if there was no previous update time, all summary contents will be fetched
        var lastUpdateTime = self.lastUpdateTime;
        self.lastUpdateTime = new Date();

        // if we don't flip this, then a fully-fetched list will not be re-checked via fetch
        this.contents.allFetched = false;
        return self.contents.fetchUpdated( lastUpdateTime )
            .done( _.bind( self.checkForUpdates, self ) );
    },

    /**  */
    checkForUpdates : function( options ){
        options = options || {};
        var delay = this.UPDATE_DELAY;
        var self = this;

        function _delayThenUpdate(){
            // prevent buildup of updater timeouts by clearing previous if any, then set new and cache id
            self.clearUpdateTimeout();
            self.updateTimeoutId = setTimeout( function(){
                self.refresh( options );
            }, delay );
        }

        // if there are still datasets in the non-ready state, recurse into this function with the new time
        if( this.numOfUnfinishedShownContents() > 0 ){
            _delayThenUpdate();

        } else {
            // no datasets are running, but currently runnning jobs may still produce new datasets
            // see if the history has any running jobs and continue to update if so
            // (also update the size for the user in either case)
            self._getSizeAndRunning()
                .done( function( historyData ){
                    if( self.numOfUnfinishedJobs() > 0 ){
                        _delayThenUpdate();

                    } else {
                        // otherwise, let listeners know that all updates have stopped
                        self.trigger( 'ready' );
                        // self.lastUpdateTime = null;
                    }
                });
        }
    },

    /** clear the timeout and the cached timeout id */
    clearUpdateTimeout : function(){
        if( this.updateTimeoutId ){
            clearTimeout( this.updateTimeoutId );
            this.updateTimeoutId = null;
        }
    },

    // ........................................................................ ajax
    /**  */
    fetchWithContents : function( options, contentsOptions ){
        // TODO: push down to a base class
        options = options || {};
        options.view = 'current';

        var self = this;
        // fetch history then use history data to fetch (paginated) contents
        return this.fetch( options ).pipe( function getContents( history ){
            self.contents.historyId = history.id;
            // reset the update time
            self.lastUpdateTime = new Date();
            return self.contents.fetch( contentsOptions );
        });
    },

    /** save this history, _Mark_ing it as deleted (just a flag) */
    _delete : function( options ){
        if( this.get( 'deleted' ) ){ return jQuery.when(); }
        return this.save( { deleted: true }, options );
    },
    /** purge this history, _Mark_ing it as purged and removing all dataset data from the server */
    purge : function( options ){
        if( this.get( 'purged' ) ){ return jQuery.when(); }
        return this.save( { deleted: true, purged: true }, options );
    },
    /** save this history, _Mark_ing it as undeleted */
    undelete : function( options ){
        if( !this.get( 'deleted' ) ){ return jQuery.when(); }
        return this.save( { deleted: false }, options );
    },

    /** Make a copy of this history on the server
     *  @param {Boolean} current    if true, set the copy as the new current history (default: true)
     *  @param {String} name        name of new history (default: none - server sets to: Copy of <current name>)
     *  @fires copied               passed this history and the response JSON from the copy
     *  @returns {xhr}
     */
    copy : function( current, name, allDatasets ){
        current = ( current !== undefined )?( current ):( true );
        if( !this.id ){
            throw new Error( 'You must set the history ID before copying it.' );
        }

        var postData = { history_id  : this.id };
        if( current ){
            postData.current = true;
        }
        if( name ){
            postData.name = name;
        }
        if( !allDatasets ){
            postData.all_datasets = false;
        }

        var history = this,
            copy = jQuery.post( this.urlRoot, postData );
        // if current - queue to setAsCurrent before firing 'copied'
        if( current ){
            return copy.then( function( response ){
                var newHistory = new History( response );
                return newHistory.setAsCurrent()
                    .done( function(){
                        history.trigger( 'copied', history, response );
                    });
            });
        }
        return copy.done( function( response ){
            history.trigger( 'copied', history, response );
        });
    },

    setAsCurrent : function(){
        var history = this,
            xhr = jQuery.getJSON( Galaxy.root + 'history/set_as_current?id=' + this.id );

        xhr.done( function(){
            history.trigger( 'set-as-current', history );
        });
        return xhr;
    },

    // ........................................................................ misc
    toString : function(){
        return 'History(' + this.get( 'id' ) + ',' + this.get( 'name' ) + ')';
    }
}));


//==============================================================================
/** @class A collection of histories (per user).
 *      (stub) currently unused.
 */
var HistoryCollection = CONTROLLED_FETCH_COLLECTION.ControlledFetchCollection
        .extend( BASE_MVC.LoggableMixin )
        .extend(/** @lends HistoryCollection.prototype */{
    _logNamespace : 'history',

    model   : History,

    /** @type {String} the default sortOrders key for sorting */
    DEFAULT_ORDER : 'update_time',

    /** @type {Object} map of collection sorting orders generally containing a getter to return the attribute
     *      sorted by and asc T/F if it is an ascending sort.
     */
    sortOrders : {
        'update_time' : {
            getter : function( h ){ return new Date( h.get( 'update_time' ) ); },
            asc : false
        },
        'update_time-asc' : {
            getter : function( h ){ return new Date( h.get( 'update_time' ) ); },
            asc : true
        },
        'name' : {
            getter : function( h ){ return h.get( 'name' ); },
            asc : true
        },
        'name-dsc' : {
            getter : function( h ){ return h.get( 'name' ); },
            asc : false
        },
        'size' : {
            getter : function( h ){ return h.get( 'size' ); },
            asc : false
        },
        'size-asc' : {
            getter : function( h ){ return h.get( 'size' ); },
            asc : true
        }
    },

    initialize : function( models, options ){
        options = options || {};
        this.log( 'HistoryCollection.initialize', arguments );

        // instance vars
        /** @type {boolean} should deleted histories be included */
        this.includeDeleted = options.includeDeleted || false;
        // set the sort order
        this.setOrder( options.order || this.DEFAULT_ORDER );
        /** @type {String} encoded id of the history that's current */
        this.currentHistoryId = options.currentHistoryId;
        /** @type {boolean} have all histories been fetched and in the collection? */
        this.allFetched = options.allFetched || false;

        // this.on( 'all', function(){
        //    console.info( 'event:', arguments );
        // });
        this.setUpListeners();
    },

    urlRoot : Galaxy.root + 'api/histories',
    url     : function(){ return this.urlRoot; },

    /** returns map of default filters and settings for fetching from the API */
    _fetchDefaults : function(){
        // to be overridden
        var defaults = {
            order   : this.order,
            view    : 'detailed'
        };
        if( !this.includeDeleted ){
            defaults.filters = {
                deleted : false,
                purged  : false,
            };
        }
        return defaults;
    },

    /** set up reflexive event handlers */
    setUpListeners : function setUpListeners(){
        this.on({
            // when a history is deleted, remove it from the collection (if optionally set to do so)
            'change:deleted' : function( history ){
                // TODO: this becomes complicated when more filters are used
                this.debug( 'change:deleted', this.includeDeleted, history.get( 'deleted' ) );
                if( !this.includeDeleted && history.get( 'deleted' ) ){
                    this.remove( history );
                }
            },
            // listen for a history copy, setting it to current
            'copied' : function( original, newData ){
                this.setCurrent( new History( newData, [] ) );
            },
            // when a history is made current, track the id in the collection
            'set-as-current' : function( history ){
                var oldCurrentId = this.currentHistoryId;
                this.trigger( 'no-longer-current', oldCurrentId );
                this.currentHistoryId = history.id;
            }
        });
    },

    /** override to allow passing options.order and setting the sort order to one of sortOrders */
    sort : function( options ){
        options = options || {};
        this.setOrder( options.order );
        return Backbone.Collection.prototype.sort.call( this, options );
    },

    /** build the comparator used to sort this collection using the sortOrder map and the given order key
     *  @event 'changed-order' passed the new order and the collection
     */
    setOrder : function( order ){
        var collection = this,
            sortOrder = this.sortOrders[ order ];
        if( _.isUndefined( sortOrder ) ){ return; }

        collection.order = order;
        collection.comparator = function comparator( a, b ){
            var currentHistoryId = collection.currentHistoryId;
            // current always first
            if( a.id === currentHistoryId ){ return -1; }
            if( b.id === currentHistoryId ){ return 1; }
            // then compare by an attribute
            a = sortOrder.getter( a );
            b = sortOrder.getter( b );
            return sortOrder.asc?
                ( ( a === b )?( 0 ):( a > b ?  1 : -1 ) ):
                ( ( a === b )?( 0 ):( a > b ? -1 :  1 ) );
        };
        collection.trigger( 'changed-order', collection.order, collection );
        return collection;
    },

    /** create a new history and by default set it to be the current history */
    create : function create( data, hdas, historyOptions, xhrOptions ){
        //TODO: .create is actually a collection function that's overridden here
        var collection = this,
            xhr = jQuery.getJSON( Galaxy.root + 'history/create_new_current'  );
        return xhr.done( function( newData ){
            collection.setCurrent( new History( newData, [], historyOptions || {} ) );
        });
    },

    /** set the current history to the given history, placing it first in the collection.
     *  Pass standard bbone options for use in unshift.
     *  @triggers new-current passed history and this collection
     */
    setCurrent : function( history, options ){
        options = options || {};
        // new histories go in the front
        this.unshift( history, options );
        this.currentHistoryId = history.get( 'id' );
        if( !options.silent ){
            this.trigger( 'new-current', history, this );
        }
        return this;
    },

    /** override to reset allFetched flag to false */
    reset : function( models, options ){
        this.allFetched = false;
        return Backbone.Collection.prototype.reset.call( this, models, options );
    },

    toString: function toString(){
        return 'HistoryCollection(' + this.length + ')';
    }
});

//==============================================================================
return {
    History           : History,
    HistoryCollection : HistoryCollection
};});
