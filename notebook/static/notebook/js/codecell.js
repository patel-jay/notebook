// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
/**
 *
 *
 * @module codecell
 * @namespace codecell
 * @class CodeCell
 */


define([
    'base/js/namespace',
    'jquery',
    'base/js/utils',
    'base/js/keyboard',
    'services/config',
    'notebook/js/cell',
    'notebook/js/outputarea',
    'notebook/js/completer',
    'notebook/js/celltoolbar',
    'codemirror/lib/codemirror',
    'codemirror/mode/python/python',
    'notebook/js/codemirror-ipython'
], function(IPython,
    $,
    utils,
    keyboard,
    configmod,
    cell,
    outputarea,
    completer,
    celltoolbar,
    CodeMirror,
    cmpython,
    cmip
    ) {
    "use strict";
    
    var Cell = cell.Cell;

    /* local util for codemirror */
    var posEq = function(a, b) {return a.line === b.line && a.ch === b.ch;};

    /**
     *
     * function to delete until previous non blanking space character
     * or first multiple of 4 tabstop.
     * @private
     */
    CodeMirror.commands.delSpaceToPrevTabStop = function(cm){
        var from = cm.getCursor(true), to = cm.getCursor(false), sel = !posEq(from, to);
         if (sel) {
            var ranges = cm.listSelections();
            for (var i = ranges.length - 1; i >= 0; i--) {
                var head = ranges[i].head;
                var anchor = ranges[i].anchor;
                cm.replaceRange("", CodeMirror.Pos(head.line, head.ch), CodeMirror.Pos(anchor.line, anchor.ch));
            }
            return;
        }
        var cur = cm.getCursor(), line = cm.getLine(cur.line);
        var tabsize = cm.getOption('tabSize');
        var chToPrevTabStop = cur.ch-(Math.ceil(cur.ch/tabsize)-1)*tabsize;
        from = {ch:cur.ch-chToPrevTabStop,line:cur.line};
        var select = cm.getRange(from,cur);
        if( select.match(/^\ +$/) !== null){
            cm.replaceRange("",from,cur);
        } else {
            cm.deleteH(-1,"char");
        }
    };

    var keycodes = keyboard.keycodes;

    var CodeCell = function (kernel, options) {
        /**
         * Constructor
         *
         * A Cell conceived to write code.
         *
         * Parameters:
         *  kernel: Kernel instance
         *      The kernel doesn't have to be set at creation time, in that case
         *      it will be null and set_kernel has to be called later.
         *  options: dictionary
         *      Dictionary of keyword arguments.
         *          events: $(Events) instance 
         *          config: dictionary
         *          keyboard_manager: KeyboardManager instance 
         *          notebook: Notebook instance
         *          tooltip: Tooltip instance
         */
        this.kernel = kernel || null;
        this.notebook = options.notebook;
        this.collapsed = false;
        this.events = options.events;
        this.tooltip = options.tooltip;
        this.config = options.config;
        this.class_config = new configmod.ConfigWithDefaults(this.config,
                                        CodeCell.config_defaults, 'CodeCell');

        // create all attributed in constructor function
        // even if null for V8 VM optimisation
        this.input_prompt_number = null;
        this.cell_uuid = null; //Edit - Jay Patel - Initialize cell_uuid as null for cell_type="code"
        this.celltoolbar = null;
        this.output_area = null;

        this.last_msg_id = null;
        this.completer = null;

        Cell.apply(this,[{
            config: $.extend({}, CodeCell.options_default), 
            keyboard_manager: options.keyboard_manager, 
            events: this.events}]);

        // Attributes we want to override in this subclass.
        this.cell_type = "code";
        var that  = this;
        this.element.focusout(
            function() { that.auto_highlight(); }
        );
    };

    CodeCell.options_default = {
        cm_config : {
            extraKeys: {
                "Tab" :  "indentMore",
                "Shift-Tab" : "indentLess",
                "Backspace" : "delSpaceToPrevTabStop",
                "Cmd-/" : "toggleComment",
                "Ctrl-/" : "toggleComment"
            },
            mode: 'text',
            theme: 'ipython',
            matchBrackets: true,
            autoCloseBrackets: true
        },
        highlight_modes : {
            'magic_javascript'    :{'reg':['^%%javascript']},
            'magic_perl'          :{'reg':['^%%perl']},
            'magic_ruby'          :{'reg':['^%%ruby']},
            'magic_python'        :{'reg':['^%%python3?']},
            'magic_shell'         :{'reg':['^%%bash']},
            'magic_r'             :{'reg':['^%%R']},
            'magic_text/x-cython' :{'reg':['^%%cython']},
        },
    };

    CodeCell.config_defaults = CodeCell.options_default;

    CodeCell.msg_cells = {};

    CodeCell.prototype = Object.create(Cell.prototype);
    
    /** @method create_element */
    CodeCell.prototype.create_element = function () {
        Cell.prototype.create_element.apply(this, arguments);
        var that = this;

        var cell =  $('<div></div>').addClass('cell code_cell');
        cell.attr('tabindex','2');

        var input = $('<div></div>').addClass('input');
        this.input = input;
        var prompt = $('<div/>').addClass('prompt input_prompt');
        var inner_cell = $('<div/>').addClass('inner_cell');
        this.celltoolbar = new celltoolbar.CellToolbar({
            cell: this, 
            notebook: this.notebook});
        inner_cell.append(this.celltoolbar.element);
        var input_area = $('<div/>').addClass('input_area');
        this.code_mirror = new CodeMirror(input_area.get(0), this._options.cm_config);
        // In case of bugs that put the keyboard manager into an inconsistent state,
        // ensure KM is enabled when CodeMirror is focused:
        this.code_mirror.on('focus', function () {
            if (that.keyboard_manager) {
                that.keyboard_manager.enable();
            }
        });
        this.code_mirror.on('keydown', $.proxy(this.handle_keyevent,this));
        $(this.code_mirror.getInputField()).attr("spellcheck", "false");
        inner_cell.append(input_area);
        input.append(prompt).append(inner_cell);

        var output = $('<div></div>');
        cell.append(input).append(output);
        this.element = cell;
        this.output_area = new outputarea.OutputArea({
            selector: output, 
            prompt_area: true, 
            events: this.events, 
            keyboard_manager: this.keyboard_manager});
        this.completer = new completer.Completer(this, this.events);
    };

    /** @method bind_events */
    CodeCell.prototype.bind_events = function () {
        Cell.prototype.bind_events.apply(this, arguments);
        var that = this;

        this.element.focusout(
            function() { that.auto_highlight(); }
        );
    };


    /**
     *  This method gets called in CodeMirror's onKeyDown/onKeyPress
     *  handlers and is used to provide custom key handling. Its return
     *  value is used to determine if CodeMirror should ignore the event:
     *  true = ignore, false = don't ignore.
     *  @method handle_codemirror_keyevent
     */

    CodeCell.prototype.handle_codemirror_keyevent = function (editor, event) {

        var that = this;
        // whatever key is pressed, first, cancel the tooltip request before
        // they are sent, and remove tooltip if any, except for tab again
        var tooltip_closed = null;
        if (event.type === 'keydown' && event.which !== keycodes.tab ) {
            tooltip_closed = this.tooltip.remove_and_cancel_tooltip();
        }

        var cur = editor.getCursor();
        if (event.keyCode === keycodes.enter){
            this.auto_highlight();
        }

        if (event.which === keycodes.down && event.type === 'keypress' && this.tooltip.time_before_tooltip >= 0) {
            // triger on keypress (!) otherwise inconsistent event.which depending on plateform
            // browser and keyboard layout !
            // Pressing '(' , request tooltip, don't forget to reappend it
            // The second argument says to hide the tooltip if the docstring
            // is actually empty
            this.tooltip.pending(that, true);
        } else if ( tooltip_closed && event.which === keycodes.esc && event.type === 'keydown') {
            // If tooltip is active, cancel it.  The call to
            // remove_and_cancel_tooltip above doesn't pass, force=true.
            // Because of this it won't actually close the tooltip
            // if it is in sticky mode. Thus, we have to check again if it is open
            // and close it with force=true.
            if (!this.tooltip._hidden) {
                this.tooltip.remove_and_cancel_tooltip(true);
            }
            // If we closed the tooltip, don't let CM or the global handlers
            // handle this event.
            event.codemirrorIgnore = true;
            event._ipkmIgnore = true;
            event.preventDefault();
            return true;
        } else if (event.keyCode === keycodes.tab && event.type === 'keydown' && event.shiftKey) {
                if (editor.somethingSelected() || editor.getSelections().length !== 1){
                    var anchor = editor.getCursor("anchor");
                    var head = editor.getCursor("head");
                    if( anchor.line !== head.line){
                        return false;
                    }
                }
                var pre_cursor = editor.getRange({line:cur.line,ch:0},cur);
                if (pre_cursor.trim() === "") {
                    // Don't show tooltip if the part of the line before the cursor
                    // is empty.  In this case, let CodeMirror handle indentation.
                    return false;
                } 
                this.tooltip.request(that);
                event.codemirrorIgnore = true;
                event.preventDefault();
                return true;
        } else if (event.keyCode === keycodes.tab && event.type === 'keydown') {
            // Tab completion.
            this.tooltip.remove_and_cancel_tooltip();

            // completion does not work on multicursor, it might be possible though in some cases
            if (editor.somethingSelected() || editor.getSelections().length > 1) {
                return false;
            }
            var pre_cursor = editor.getRange({line:cur.line,ch:0},cur);
            if (pre_cursor.trim() === "") {
                // Don't autocomplete if the part of the line before the cursor
                // is empty.  In this case, let CodeMirror handle indentation.
                return false;
            } else {
                event.codemirrorIgnore = true;
                event.preventDefault();
                this.completer.startCompletion();
                return true;
            }
        } 
        
        // keyboard event wasn't one of those unique to code cells, let's see
        // if it's one of the generic ones (i.e. check edit mode shortcuts)
        return Cell.prototype.handle_codemirror_keyevent.apply(this, [editor, event]);
    };

    // Kernel related calls.

    CodeCell.prototype.set_kernel = function (kernel) {
        this.kernel = kernel;
    };

    /**
     * Execute current code cell to the kernel
     * @method execute
     */
    CodeCell.prototype.execute = function (stop_on_error) {
        if (!this.kernel) {
            console.log("Can't execute cell since kernel is not set.");
            return;
        }

        if (stop_on_error === undefined) {
            stop_on_error = true;
        }

        this.output_area.clear_output(false, true);
        var old_msg_id = this.last_msg_id;
        if (old_msg_id) {
            this.kernel.clear_callbacks_for_msg(old_msg_id);
            delete CodeCell.msg_cells[old_msg_id];
            this.last_msg_id = null;
        }
        if (this.get_text().trim().length === 0) {
            // nothing to do
            this.set_input_prompt(null);
            return;
        }
        this.set_input_prompt('*');
        this.element.addClass("running");
        var callbacks = this.get_callbacks();
        
        /*Edit - Jay Patel - set uuid - generate new uuid if no uuid is assigned to a cell*/        
        if(this.get_uuid()===undefined || this.get_uuid()===null){
            this.set_uuid(0);
        }
        
        this.last_msg_id = this.kernel.execute(this.get_text(), callbacks, {silent: false, store_history: true,
            stop_on_error : stop_on_error, cell_uuid : this.cell_uuid}); /*Edit - Jay Patel - Added cell_uuid*/
        CodeCell.msg_cells[this.last_msg_id] = this;
        this.render();
        this.events.trigger('execute.CodeCell', {cell: this});
    };
    
    /**
     * Construct the default callbacks for
     * @method get_callbacks
     */
    CodeCell.prototype.get_callbacks = function () {
        var that = this;
        return {
            shell : {
                reply : $.proxy(this._handle_execute_reply, this),
                payload : {
                    set_next_input : $.proxy(this._handle_set_next_input, this),
                    page : $.proxy(this._open_with_pager, this)
                }
            },
            iopub : {
                output : function() { 
                    that.output_area.handle_output.apply(that.output_area, arguments);
                }, 
                clear_output : function() { 
                    that.output_area.handle_clear_output.apply(that.output_area, arguments);
                }, 
            },
            input : $.proxy(this._handle_input_request, this)
        };
    };
    
    CodeCell.prototype._open_with_pager = function (payload) {
        this.events.trigger('open_with_text.Pager', payload);
    };

    /**
     * @method _handle_execute_reply
     * @private
     */
    CodeCell.prototype._handle_execute_reply = function (msg) {
        this.set_input_prompt(msg.content.execution_count);
        this.element.removeClass("running");
        this.events.trigger('set_dirty.Notebook', {value: true});
    };

    /**
     * @method _handle_set_next_input
     * @private
     */
    CodeCell.prototype._handle_set_next_input = function (payload) {
        var data = {
            cell: this,
            text: payload.text,
            replace: payload.replace,
            clear_output: payload.clear_output,
        };
        this.events.trigger('set_next_input.Notebook', data);
    };

    /**
     * @method _handle_input_request
     * @private
     */
    CodeCell.prototype._handle_input_request = function (msg) {
        this.output_area.append_raw_input(msg);
    };


    // Basic cell manipulation.

    CodeCell.prototype.select = function () {
        var cont = Cell.prototype.select.apply(this, arguments);
        if (cont) {
            this.code_mirror.refresh();
            this.auto_highlight();
        }
        return cont;
    };

    CodeCell.prototype.render = function () {
        var cont = Cell.prototype.render.apply(this, arguments);
        // Always execute, even if we are already in the rendered state
        return cont;
    };
    
    CodeCell.prototype.select_all = function () {
        var start = {line: 0, ch: 0};
        var nlines = this.code_mirror.lineCount();
        var last_line = this.code_mirror.getLine(nlines-1);
        var end = {line: nlines-1, ch: last_line.length};
        this.code_mirror.setSelection(start, end);
    };


    CodeCell.prototype.collapse_output = function () {
        this.output_area.collapse();
    };


    CodeCell.prototype.expand_output = function () {
        this.output_area.expand();
        this.output_area.unscroll_area();
    };

    CodeCell.prototype.scroll_output = function () {
        this.output_area.expand();
        this.output_area.scroll_if_long();
    };

    CodeCell.prototype.toggle_output = function () {
        this.output_area.toggle_output();
    };

    CodeCell.prototype.toggle_output_scroll = function () {
        this.output_area.toggle_scroll();
    };


    CodeCell.input_prompt_classical = function (prompt_value, lines_number) {
        var ns;
        if (prompt_value === undefined || prompt_value === null) {
            ns = "&nbsp;";
        } else {
            ns = encodeURIComponent(prompt_value);
        }
        return 'In&nbsp;[' + ns + ']:';
    };

    CodeCell.input_prompt_continuation = function (prompt_value, lines_number) {
        var html = [CodeCell.input_prompt_classical(prompt_value, lines_number)];
        for(var i=1; i < lines_number; i++) {
            html.push(['...:']);
        }
        return html.join('<br/>');
    };

    CodeCell.input_prompt_function = CodeCell.input_prompt_classical;


    CodeCell.prototype.set_input_prompt = function (number) {
        var nline = 1;
        if (this.code_mirror !== undefined) {
           nline = this.code_mirror.lineCount();
        }
        this.input_prompt_number = number;
        var prompt_html = CodeCell.input_prompt_function(this.input_prompt_number, nline);
        // This HTML call is okay because the user contents are escaped.
        this.element.find('div.input_prompt').html(prompt_html);
    };


    CodeCell.prototype.clear_input = function () {
        this.code_mirror.setValue('');
    };


    CodeCell.prototype.get_text = function () {
        return this.code_mirror.getValue();
    };


    CodeCell.prototype.set_text = function (code) {
        return this.code_mirror.setValue(code);
    };


    CodeCell.prototype.clear_output = function (wait) {
        this.output_area.clear_output(wait);
        this.set_input_prompt();
    };


    // JSON serialization

    CodeCell.prototype.fromJSON = function (data) {
        Cell.prototype.fromJSON.apply(this, arguments);
        if (data.cell_type === 'code') {
            if (data.source !== undefined) {
                this.set_text(data.source);
                // make this value the starting point, so that we can only undo
                // to this state, instead of a blank cell
                this.code_mirror.clearHistory();
                this.auto_highlight();
            }

    /*Edit - Jay Patel - set uuid as input_prompt and as uuid */
            //this.set_input_prompt(data.execution_count);
            this.set_input_prompt(data.cell_uuid);
            this.set_uuid(data.cell_uuid); /*----------------*/
            this.output_area.trusted = data.metadata.trusted || false;
            this.output_area.fromJSON(data.outputs, data.metadata);
        }
    };

    CodeCell.prototype.toJSON = function () {
        var data = Cell.prototype.toJSON.apply(this);
        data.source = this.get_text();
        // is finite protect against undefined and '*' value
        if (isFinite(this.input_prompt_number)) {
            data.execution_count = this.input_prompt_number;
        } else {
            data.execution_count = null; 
        }
    /* Edit - Jay Patel - get uuid and assign it to cell_uuid*/ 
        data.cell_uuid = this.get_uuid();
        var outputs = this.output_area.toJSON();
        data.outputs = outputs;
        data.metadata.trusted = this.output_area.trusted;
        data.metadata.collapsed = this.output_area.collapsed;
        if (this.output_area.scroll_state === 'auto') {
            delete data.metadata.scrolled;
        } else {
            data.metadata.scrolled = this.output_area.scroll_state;
        }
        return data;
    };
    
    /* Edit - Jay Patel - generate uuid and getter and setter methods for cell_uuid */ 
    /*Reference taken from /base/js/utils.js*/
    CodeCell.prototype.generate_uuid = function () {
        /**
         * http://www.ietf.org/rfc/rfc4122.txt
         */
        var s = [];
        var hexDigits = "0123456789abcdef";
        for (var i = 0; i < 32; i++) {
            s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
        }
        s[12] = "4";  // bits 12-15 of the time_hi_and_version field to 0010
        s[16] = hexDigits.substr((s[16] & 0x3) | 0x8, 1);  // bits 6-7 of the clock_seq_hi_and_reserved to 01

        var uuid = s.join("");
        return uuid;
    };
    
    /* Edit - Jay Patel - getter and setter methods for cell_uuid */ 
    CodeCell.prototype.set_uuid = function(uuid){
        if(uuid===0)
            this.cell_uuid = this.generate_uuid();
        else
            this.cell_uuid = uuid;
    };
    
    CodeCell.prototype.get_uuid = function(){
        return this.cell_uuid;
    };

    /**
     * handle cell level logic when the cell is unselected
     * @method unselect
     * @return is the action being taken
     */
    CodeCell.prototype.unselect = function() {
        var cont = Cell.prototype.unselect.apply(this, arguments);
        if (cont) {
            // When a code cell is unselected, make sure that the corresponding
            // tooltip and completer to that cell is closed.
            this.tooltip.remove_and_cancel_tooltip(true);
            if (this.completer !== null) {
                this.completer.close();
            }
        }
        return cont;
    };

    // Backwards compatability.
    IPython.CodeCell = CodeCell;

    return {'CodeCell': CodeCell};
});
