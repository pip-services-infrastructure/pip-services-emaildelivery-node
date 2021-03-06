let _ = require('lodash');
let async = require('async');
let mustache = require('mustache');

import { ConfigParams } from 'pip-services3-commons-node';
import { IConfigurable } from 'pip-services3-commons-node';
import { IReferences } from 'pip-services3-commons-node';
import { Descriptor } from 'pip-services3-commons-node';
import { IReferenceable } from 'pip-services3-commons-node';
import { DependencyResolver } from 'pip-services3-commons-node';
import { ConnectionParams } from 'pip-services3-components-node';
import { ConnectionResolver } from 'pip-services3-components-node';
import { CredentialParams } from 'pip-services3-components-node';
import { CredentialResolver } from 'pip-services3-components-node';
import { ICommandable } from 'pip-services3-commons-node';
import { CommandSet } from 'pip-services3-commons-node';
import { BadRequestException } from 'pip-services3-commons-node';
import { IOpenable } from 'pip-services3-commons-node';

import { EmailMessageV1 } from '../data/version1/EmailMessageV1';
import { EmailRecipientV1 } from '../data/version1/EmailRecipientV1';
import { IEmailController } from './IEmailController';
import { EmailCommandSet } from './EmailCommandSet';

export class EmailController implements IConfigurable, IReferenceable, ICommandable, IOpenable, IEmailController {
    private static _defaultConfig: ConfigParams = ConfigParams.fromTuples(
        'message.from', null,
        'message.cc', null,
        'message.bcc', null,
        'message.reply_to', null
    );

    private _config: ConfigParams;

    private _messageFrom: string;
    private _messageCc: string;
    private _messageBcc: string;
    private _messageReplyTo: string;
    private _parameters: ConfigParams = new ConfigParams();

    private _connection: ConnectionParams;
    private _connectionResolver: ConnectionResolver = new ConnectionResolver();
    private _credential: CredentialParams;
    private _credentialResolver: CredentialResolver = new CredentialResolver();
    private _transport: any;
    private _commandSet: EmailCommandSet;
    private _disabled: boolean = false;

    public configure(config: ConfigParams): void {
        this._config = config.setDefaults(EmailController._defaultConfig);

        this._messageFrom = config.getAsStringWithDefault("message.from", this._messageFrom);
        this._messageCc = config.getAsStringWithDefault("message.cc", this._messageCc);
        this._messageBcc = config.getAsStringWithDefault("message.bcc", this._messageBcc);
        this._messageReplyTo = config.getAsStringWithDefault("message.reply_to", this._messageReplyTo);
        this._parameters = config.getSection("parameters");
        this._disabled = config.getAsBooleanWithDefault("options.disabled", this._disabled);

        this._connectionResolver.configure(config);
        this._credentialResolver.configure(config);
    }

    public setReferences(references: IReferences): void {
        this._connectionResolver.setReferences(references);
        this._credentialResolver.setReferences(references);
    }

    public getCommandSet(): CommandSet {
        if (this._commandSet == null)
            this._commandSet = new EmailCommandSet(this);
        return this._commandSet;
    }

    public isOpen(): boolean {
        return this._transport != null;
    }

    public open(correlationId: string, callback: (err: any) => void): void {
        if (this._transport) {
            callback(null);
            return;
        }

        async.series([
            (callback) => {
                this._connectionResolver.resolve(correlationId, (err, connection) => {
                    this._connection = connection;
                    callback(err);
                });
            },
            (callback) => {
                this._credentialResolver.lookup(correlationId, (err, credential) => {
                    this._credential = credential;
                    callback(err);
                });
            },
            (callback) => {
                if (this._connection != null) {
                    let nodemailer = require('nodemailer');

                    let params: any = {
                        host: this._connection.getHost(),
                        secure: this._connection.getAsBoolean('ssl')
                            || this._connection.getAsBoolean('secure')
                            || this._connection.getAsBoolean('secure_connection'),
                        port: this._connection.getPort(),
                    };

                    if (this._credential != null) {
                        params.auth = {
                            type: this._credential.getAsString("type"),
                            user: this._credential.getUsername(),
                            pass: this._credential.getPassword()
                        }
                    }

                    this._transport = nodemailer.createTransport(params);
                }

                callback();
            }
        ], callback);
    }

    public close(correlationId: string, callback: (err: any) => void): void {
        this._transport = null;

        callback(null);
    }

    private getLanguageTemplate(value: any, language: string = 'en') {
        if (value == null) return value;
        if (!_.isObject(value)) return value;

        // Set default language
        language = language || "en";

        // Get template for specified language
        let template = value[language];

        // Get template for default language
        if (template == null)
            template = value["en"];

        return "" + template;
    }

    private renderTemplate(value: any, parameters: ConfigParams, language: string = 'en'): string {
        let template = this.getLanguageTemplate(value, language);
        return template ? mustache.render(template, parameters) : null;
    }

    public sendMessage(correlationId: string, message: EmailMessageV1, parameters: ConfigParams,
        callback?: (err: any) => void): void {

        // Silentry skip if disabled
        if (this._disabled) {
            if (callback) callback(null);
            return;
        }

        // Skip processing if email is disabled or message has no destination
        if (this._transport == null || message.to == null) {
            let err = new BadRequestException(
                correlationId,
                'EMAIL_DISABLED',
                'emails disabled, or email recipient not set'
            );
            if (callback) callback(err);
            return;
        }

        try {
            parameters = this._parameters.override(parameters);

            let subject = this.renderTemplate(message.subject, parameters);
            let text = this.renderTemplate(message.text, parameters);
            let html = this.renderTemplate(message.html, parameters);

            let envelop: any = {
                from: message.from || this._messageFrom,
                cc: message.cc || this._messageCc,
                bcc: message.bcc || this._messageBcc,
                replyTo: message.reply_to || this._messageReplyTo,

                to: message.to,

                subject: subject,
                text: text,
                html: html
            };

            this._transport.sendMail(envelop, callback);
        } catch (ex) {
            callback(ex);
        }
    }

    private makeRecipientParameters(recipient: EmailRecipientV1, parameters: any): ConfigParams {
        parameters = this._parameters.override(parameters);
        parameters.append(recipient);
        return parameters;
    }

    public sendMessageToRecipient(correlationId: string, recipient: EmailRecipientV1,
        message: EmailMessageV1, parameters: ConfigParams, callback?: (err: any) => void) {

        // Silentry skip if disabled
        if (this._disabled) {
            if (callback) callback(null);
            return;
        }

        // Skip processing if email is disabled
        if (this._transport == null || recipient == null || recipient.email == null) {
            let err = new BadRequestException(
                correlationId,
                'EMAIL_DISABLED',
                'emails disabled, or recipients email not set'
            );
            if (callback) callback(err);
            return;
        }

        try {
            let recParams = this.makeRecipientParameters(recipient, parameters);
            let recLanguage = recipient.language;

            let subject = this.renderTemplate(message.subject, recParams, recLanguage);
            let text = this.renderTemplate(message.text, recParams, recLanguage);
            let html = this.renderTemplate(message.html, recParams, recLanguage);

            let envelop: any = {
                from: message.from || this._messageFrom,
                cc: message.cc || this._messageCc,
                bcc: message.bcc || this._messageBcc,
                replyTo: message.reply_to || this._messageReplyTo,

                to: recipient.email,

                subject: subject,
                text: text,
                html: html
            };

            this._transport.sendMail(envelop, callback);
        } catch (ex) {
            callback(ex);
        }
    }

    public sendMessageToRecipients(correlationId: string, recipients: EmailRecipientV1[],
        message: EmailMessageV1, parameters: ConfigParams, callback?: (err: any) => void): void {

        // Silentry skip if disabled
        if (this._disabled) {
            if (callback) callback(null);
            return;
        }

        // Skip processing if email is disabled
        if (this._transport == null || recipients == null || recipients.length == 0) {
            let err = new BadRequestException(
                correlationId,
                'EMAIL_DISABLED',
                'emails disabled, or no recipients sent'
            );
            if (callback) callback(err);
            return;
        }

        // Send email separately to each user
        async.each(recipients, (recipient, callback) => {
            this.sendMessageToRecipient(correlationId, recipient, message, parameters, callback);
        }, callback);
    }

}
