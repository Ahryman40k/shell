const Me = imports.misc.extensionUtils.getCurrentExtension();

import * as Ecs from 'ecs';
import * as Lib from 'lib';
import * as Log from 'log';
import * as Rect from 'rectangle';
import * as Node from 'node';
import * as Fork from 'fork';

import type { Entity } from 'ecs';
import type { Rectangle } from './rectangle';
import type { ShellWindow } from './window';
import type { Ext } from './extension';

enum Measure {
    Horizontal = 2,
    Vertical = 3,
}

/**
 * The world containing all forks and their attached windows, which is responible for
 * handling all automatic tiling and reflowing as windows are moved, closed, and resized
 */
export class AutoTiler extends Ecs.World {
    toplevel: Map<String, [Entity, [number, number]]>;
    forks: Ecs.Storage<Fork.Fork>;
    move_windows: boolean = true;

    private string_reps: Ecs.Storage<string>;

    private on_attach: (parent: Entity, child: Entity) => void

    constructor() {
        super();

        /// Maintains a list of top-level forks.
        this.toplevel = new Map();

        // Needed when we're storing the entities in a map, because JS limitations.
        this.string_reps = this.register_storage();

        /// The storage for holding all fork associations
        this.forks = this.register_storage();

        // The callback to execute when a window has been attached to a fork.
        this.on_attach = () => { };
    }

    /**
     * Attaches a `new` window to the fork which `onto` is attached to.
     */
    attach_window(ext: Ext, onto_entity: Entity, new_entity: Entity): [Entity, Fork.Fork] | null {
        Log.debug(`attaching Window(${new_entity}) onto Window(${onto_entity})`);

        for (const [entity, fork] of this.forks.iter()) {
            if (fork.left.is_window(onto_entity)) {
                const node = Node.Node.window(new_entity);
                if (fork.right) {
                    const area = fork.area_of_left(ext) as Rectangle;
                    const result = this.create_fork(fork.left, node, area, fork.workspace);
                    fork.left = Node.Node.fork(result[0]);
                    Log.debug(`attached Fork(${result[0]}) to Fork(${entity}).left`);
                    result[1].set_parent(entity);
                    return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, result);
                } else {
                    fork.right = node;
                    return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, null);
                }
            } else if (fork.right && fork.right.is_window(onto_entity)) {
                const area = fork.area_of_right(ext) as Rectangle;
                const result = this.create_fork(fork.right, Node.Node.window(new_entity), area, fork.workspace);
                fork.right = Node.Node.fork(result[0]);
                Log.debug(`attached Fork(${result[0]}) to Fork(${entity}).right`);
                result[1].set_parent(entity);
                return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, result);
            }
        }

        return null;
    }

    /**
     * Assigns the callback to trigger when a window is attached to a fork
     */
    connect_on_attach(callback: (parent: Entity, child: Entity) => void): AutoTiler {
        this.on_attach = callback;
        return this;
    }

    /**
     * Creates a new fork entity in the world
     *
     * @return Entity
     */
    create_entity(): Entity {
        const entity = super.create_entity();
        this.string_reps.insert(entity, `${entity}`);
        return entity;
    }

    /**
     * Create a new fork, where the left portion is a window `Entity`
     */
    create_fork(left: Node.Node, right: Node.Node | null, area: Rectangle, workspace: number): [Entity, Fork.Fork] {
        const entity = this.create_entity();
        let fork = new Fork.Fork(left, right, area, workspace);

        fork.set_orientation(area && area.width > area.height ? Lib.Orientation.HORIZONTAL : Lib.Orientation.VERTICAL);

        this.forks.insert(entity, fork);
        return [entity, fork];
    }

    /**
     * Create a new top level fork
     */
    create_toplevel(ext: Ext, window: Entity, area: Rectangle, id: [number, number]): [Entity, Fork.Fork] {
        const [entity, fork] = this.create_fork(Node.Node.window(window), null, area, id[1]);
        this.string_reps.with(entity, (sid) => {
            fork.set_toplevel(ext, this, entity, sid, id);
        });

        return [entity, fork];
    }

    /**
     * Deletes a fork entity from the world, performing any cleanup necessary
     */
    delete_entity(entity: Entity) {
        const fork = this.forks.remove(entity);
        if (fork && fork.is_toplevel) {
            const id = this.string_reps.get(entity);
            if (id) this.toplevel.delete(id);
        }

        super.delete_entity(entity);
    }

    /**
     * Detaches an entity from the a fork, re-arranging the fork's tree as necessary
     */
    detach(fork_entity: Entity, window: Entity): [Entity, Fork.Fork] | null {
        let reflow_fork = null;

        this.forks.with(fork_entity, (fork) => {
            Log.debug(`detaching Window(${window}) from Fork(${fork_entity})`);

            if (fork.left.is_window(window)) {
                if (fork.parent && fork.right) {
                    Log.debug(`detaching Fork(${fork_entity}) and holding Window(${fork.right.entity}) for reassignment`);
                    reflow_fork = [fork.parent, this.reassign_child_to_parent(fork_entity, fork.parent, fork.right)];
                } else if (fork.right) {
                    reflow_fork = [fork_entity, fork];
                    if (fork.right.kind ==Node.NodeKind.WINDOW) {
                        const detached = fork.right;
                        fork.left = detached;
                        fork.right = null;
                    } else {
                        this.reassign_children_to_parent(fork_entity, fork.right.entity, fork);
                    }
                } else {
                    Log.debug(`deleting childless and parentless Fork(${fork_entity})`);
                    this.delete_entity(fork_entity);
                }
            } else if (fork.right && fork.right.is_window(window)) {
                // Same as the `fork.left` branch.
                if (fork.parent) {
                    Log.debug(`detaching Fork(${fork_entity}) and holding Window(${fork.left.entity}) for reassignment`);
                    reflow_fork = [fork.parent, this.reassign_child_to_parent(fork_entity, fork.parent, fork.left)];
                } else {
                    reflow_fork = [fork_entity, fork];

                    if (fork.left.kind ==Node.NodeKind.FORK) {
                        this.reassign_children_to_parent(fork_entity, fork.left.entity, fork);
                    } else {
                        fork.right = null;
                    }
                }
            }
        });

        if (reflow_fork) {
            Log.debug(`reflowing Fork(${reflow_fork[0]})`);
        }

        return reflow_fork;
    }

    /**
     * Creates a string representation of every fork in the world; formatted for human consumption
     */
    display(ext: Ext, fmt: string) {
        for (const [entity, _] of this.toplevel.values()) {
            Log.debug(`displaying fork (${entity})`);
            const fork = this.forks.get(entity);

            fmt += ' ';
            if (fork) {
                fmt += this.display_fork(ext, entity, fork, 1) + '\n';
            } else {
                fmt += `Fork(${entity}) Invalid\n`;
            }
        }

        return fmt;
    }

    /**
     * Finds the top level fork associated with the given entity
     */
    find_toplevel(id: [number, number]): Entity | null {
        for (const [entity, [mon, work]] of this.toplevel.values()) {
            if (mon == id[0] && work == id[1]) {
                Log.log(`found top level at Fork(${entity})`);
                return entity;
            }
        }

        return null;
    }

    /**
     * Grows a sibling a fork
     */
    grow_sibling(ext: Ext, fork_e: Entity, fork_c: Fork.Fork, is_left: boolean, movement: Lib.Movement, crect: Rectangle, failure_allowed: boolean) {
        if (fork_c.is_horizontal()) {
            if ((movement & (Lib.Movement.DOWN | Lib.Movement.UP)) != 0) {
                Log.debug(`growing Fork(${fork_e}) up/down`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 3, failure_allowed);
            } else if (is_left) {
                if ((movement & Lib.Movement.RIGHT) != 0) {
                    Log.debug(`growing left child of Fork(${fork_e}) from left to right`);
                    this.readjust_fork_ratio_by_left(ext, crect.width, fork_c, fork_c.area.width, failure_allowed);
                } else {
                    Log.debug(`growing left child of Fork(${fork_e}) from right to left`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2, failure_allowed);
                }
            } else if ((movement & Lib.Movement.RIGHT) != 0) {
                Log.debug(`growing right child of Fork(${fork_e}) from left to right`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2, failure_allowed);
            } else {
                Log.debug(`growing right child of Fork(${fork_e}) from right to left`);
                this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.width, failure_allowed);
            }
        } else {
            if ((movement & (Lib.Movement.LEFT | Lib.Movement.RIGHT)) != 0) {
                Log.debug(`growing Fork(${fork_e}) left/right`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 2, failure_allowed);
            } else if (is_left) {
                if ((movement & Lib.Movement.DOWN) != 0) {
                    Log.debug(`growing left child of Fork(${fork_e}) from top to bottom`);
                    this.readjust_fork_ratio_by_left(ext, crect.height, fork_c, fork_c.area.height, failure_allowed);
                } else {
                    Log.debug(`growing left child of Fork(${fork_e}) from bottom to top`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3, failure_allowed);
                }
            } else if ((movement & Lib.Movement.DOWN) != 0) {
                Log.debug(`growing right child of Fork(${fork_e}) from top to bottom`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3, failure_allowed);
            } else {
                Log.debug(`growing right child of Fork(${fork_e}) from bottom to top`);
                this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.height, failure_allowed);
            }
        }
    }

    * iter(entity: Entity, kind:Node.NodeKind): IterableIterator<Node.Node> {
        let fork = this.forks.get(entity);
        let forks = new Array(2);

        while (fork) {
            if (fork.left.kind ==Node.NodeKind.FORK) {
                forks.push(this.forks.get(fork.left.entity));
            }

            if (kind === null || fork.left.kind == kind) {
                yield fork.left
            }

            if (fork.right) {
                if (fork.right.kind ==Node.NodeKind.FORK) {
                    forks.push(this.forks.get(fork.right.entity));
                }

                if (kind === null || fork.right.kind == kind) {
                  yield fork.right;
                }
            }

            fork = forks.pop();
        }
    }

    /**
     * Finds the largest window on a monitor + workspace
     */
    largest_window_on(ext: Ext, entity: Entity): ShellWindow | null {
        let largest_window = null;
        let largest_size = 0;

        for (const win of this.iter(entity,Node.NodeKind.WINDOW)) {
            const window = ext.windows.get(win.entity);

            if (window) {
                const rect = window.rect();
                const size = rect.width * rect.height;
                if (size > largest_size) {
                    largest_size = size;
                    largest_window = window;
                }
            }
        }

        return largest_window;
    }

    /**
     * Reassigns the child of a fork to the parent
     */
    reassign_child_to_parent(child_entity: Entity, parent_entity: Entity, branch: Node.Node): Fork.Fork | null {
        Log.debug(`reassigning Fork(${child_entity}) to parent Fork(${parent_entity})`);
        const parent = this.forks.get(parent_entity);

        if (parent) {
            if (parent.left.is_fork(child_entity)) {
                parent.left = branch;
                Log.debug(`reassigned Fork(${parent_entity}).left to (${parent.left.entity})`);
            } else {
                parent.right = branch;
                Log.debug(`reassigned Fork(${parent_entity}).right to (${parent.right.entity})`);
            }

            this.reassign_sibling(branch, parent_entity);
            this.delete_entity(child_entity);
        }

        return parent
    }

    /**
     * Reassigns a sibling based on whether it is a fork or a window.
     *
     * - If the sibling is a fork, reassign the parent.
     * - If it is a window, simply call on_attach
     */
    reassign_sibling(sibling: Node.Node, parent: Entity) {
        (sibling.kind ==Node.NodeKind.FORK ? this.reassign_parent : this.on_attach)
            .call(this, parent, sibling.entity);
    }

    /**
     * Reassigns children of the child entity to the parent entity
     *
     * Each fork has a left and optional right child entity
     */
    reassign_children_to_parent(parent_entity: Entity, child_entity: Entity, p_fork: Fork.Fork) {
        Log.debug(`reassigning children of Fork(${child_entity}) to Fork(${parent_entity})`);

        const c_fork = this.forks.get(child_entity);

        if (c_fork) {
            p_fork.left = c_fork.left;
            p_fork.right = c_fork.right;

            this.reassign_sibling(p_fork.left, parent_entity);
            if (p_fork.right) this.reassign_sibling(p_fork.right, parent_entity);

            this.delete_entity(child_entity);
        } else {
            Log.error(`Fork(${child_entity}) does not exist`);
        }
    }

    /**
     * Reassigns a child to the given parent
     */
    reassign_parent(parent: Entity, child: Entity) {
        Log.debug(`assigning parent of Fork(${child}) to Fork(${parent})`);
        this.forks.with(child, (fork) => fork.set_parent(parent));
    }

    /**
     * Resizes the sibling of a fork
     */
    resize(ext: Ext, fork_e: Entity, win_e: Entity, movement: Lib.Movement, crect: Rectangle, failure_allowed: boolean) {
        this.forks.with(fork_e, (fork_c) => {
            const is_left = fork_c.left.is_window(win_e);

            ((movement & Lib.Movement.SHRINK) != 0 ? this.shrink_sibling : this.grow_sibling)
                .call(this, ext, fork_e, fork_c, is_left, movement, crect, failure_allowed);
        });
    }

    resize_parent(parent: Fork.Fork, child: Fork.Fork, is_left: boolean, measure: Measure) {
        if (child.area.eq(parent.area)) return;

        const parent_measure = parent.is_horizontal() ? Measure.Horizontal : Measure.Vertical;
        if (parent_measure != measure) return;

        parent.set_ratio(
            is_left
                ? child.area.array[parent_measure]
                : (parent.area.array[parent_measure] - child.area.array[parent_measure])
        );
    }

    /// Readjusts the division of space between the left and right siblings of a fork
    readjust_fork_ratio_by_left(ext: Ext, left_length: number, fork: Fork.Fork, fork_length: number, failure_allowed: boolean) {
        const prev_left = fork.left_length;
        if (!fork.set_ratio(left_length).tile(this, ext, fork.area, fork.workspace, failure_allowed) || failure_allowed) {
            fork.left_length = prev_left;
            fork.tile(this, ext, fork.area, fork.workspace, failure_allowed);
        }
    }

    /// Readjusts the division of space between the left and right siblings of a fork
    ///
    /// Determines the size of the left sibling based on the new length of the right sibling
    readjust_fork_ratio_by_right(ext: Ext, right_length: number, fork: Fork.Fork, fork_length: number, failure_allowed: boolean) {
        this.readjust_fork_ratio_by_left(ext, fork_length - right_length, fork, fork_length, failure_allowed);
    }

    resize_fork_in_direction(ext: Ext, child_e: Entity, child: Fork.Fork, is_left: boolean, consider_sibling: boolean, crect: Rectangle, measure: Measure, failure_allowed: boolean) {
        Log.debug(`resizing fork in direction ${measure}: considering ${consider_sibling}`);
        const original = new Rect.Rectangle([crect.x, crect.y, crect.width, crect.height]);
        let length = (measure == Measure.Horizontal ? crect.width : crect.height);

        if (consider_sibling) {
            let area_left = child.area_of_left(ext);
            if (area_left) {
                length += is_left
                    ? child.area.array[measure] - area_left.array[measure]
                    : area_left.array[measure];
            }
        }

        const shrinking = length < child.area.array[measure];

        let done = false;
        let prev_area = child.area.clone();
        while (child.parent && !done) {
            const parent = this.forks.get(child.parent);
            if (parent && parent.area) {
                prev_area = parent.area.clone();
                if (parent.area.contains(original)) {
                    if (shrinking) {
                        Log.debug(`Fork(${child_e}) area before: ${child.area?.fmt()}`);
                        if (child.area) child.area.array[measure] = length;
                        Log.debug(`Fork(${child_e}) area after ${child.area?.fmt()}`);
                    } else {
                        Log.info("breaking");
                        if (child.area) child.area.array[measure] = length;
                        this.resize_parent(parent, child, parent.left.is_fork(child_e), measure);
                        done = true;
                    }
                } else if (shrinking) {
                    Log.info("breaking");
                    this.resize_parent(parent, child, parent.left.is_fork(child_e), measure);
                    done = true;
                } else {
                    Log.debug(`Fork(${child_e}) area before: ${child.area}`);
                    if (child.area) child.area.array[measure] = length;
                    parent.area.array[measure] = length;
                    Log.debug(`Fork(${child_e}) area after ${child.area}`);
                }

                this.resize_parent(parent, child, parent.left.is_fork(child_e), measure);

                child_e = child.parent;
                child = parent;
            } else {
                break
            }
        }


        if (!child.tile(this, ext, child.area as Rectangle, child.workspace, failure_allowed) && !failure_allowed) {
            Log.debug(`failure resizing Fork(${child_e})`);
            child.tile(this, ext, prev_area, child.workspace, failure_allowed);
        }
    }

    /**
     * Shrinks the sibling of a fork, possibly shrinking the fork itself.
     */
    shrink_sibling(ext: Ext, fork_e: Entity, fork_c: Fork.Fork, is_left: boolean, movement: Lib.Movement, crect: Rectangle, failure_allowed: boolean) {
        if (fork_c.is_horizontal()) {
            if ((movement & (Lib.Movement.DOWN | Lib.Movement.UP)) != 0) {
                Log.debug(`shrinking Fork(${fork_e}) up/down`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 3, failure_allowed);
            } else if (is_left) {
                if ((movement & Lib.Movement.LEFT) != 0) {
                    Log.debug(`shrinking left child of Fork(${fork_e}) from right to left`);
                    this.readjust_fork_ratio_by_left(ext, crect.width, fork_c, fork_c.area.array[2], failure_allowed);
                } else {
                    Log.debug(`shrinking left child of Fork(${fork_e}) from left to right`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2, failure_allowed);
                }
            } else if ((movement & Lib.Movement.LEFT) != 0) {
                Log.debug(`shrinking right child of Fork(${fork_e}) from right to left`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2, failure_allowed);
            } else {
                Log.debug(`shrinking right child of Fork(${fork_e}) from left to right`);
                this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.array[2], failure_allowed);
            }
        } else {
            if ((movement & (Lib.Movement.LEFT | Lib.Movement.RIGHT)) != 0) {
                Log.debug(`shrinking Fork(${fork_e}) left/right`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 2, failure_allowed);
            } else if (is_left) {
                if ((movement & Lib.Movement.UP) != 0) {
                    Log.debug(`shrinking left child of Fork(${fork_e}) from bottom to top`);
                    this.readjust_fork_ratio_by_left(ext, crect.height, fork_c, fork_c.area.array[3], failure_allowed);
                } else {
                    Log.debug(`shrinking left child of Fork(${fork_e}) from top to bottom`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3, failure_allowed);
                }
            } else if ((movement & Lib.Movement.UP) != 0) {
                Log.debug(`shrinking right child of Fork(${fork_e}) from bottom to top`);
                this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3, failure_allowed);
            } else {
                Log.debug(`shrinking right child of Fork(${fork_e}) from top to bottom`);
                this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.array[3], failure_allowed);
            }
        }
    }

    private _attach(
        onto_entity: Entity,
        new_entity: Entity,
        assoc: (a: Entity, b: Entity) => void,
        entity: Entity,
        fork: Fork.Fork,
        result: [Entity, Fork.Fork] | null
    ): [Entity, Fork.Fork] | null {
        if (result) {
            assoc(result[0], onto_entity);
            assoc(result[0], new_entity);
        } else {
            assoc(entity, new_entity);
        }

        return [entity, fork];
    }

    private display_branch(ext: Ext, branch: Node.Node, scope: number): string {
        if (branch.kind ==Node.NodeKind.WINDOW) {
            const window = ext.windows.get(branch.entity);
            return `Window(${branch.entity}) (${window ? window.rect().fmt() : "unknown area"})`;
        } else {
            const fork = this.forks.get(branch.entity);
            return fork ? this.display_fork(ext, branch.entity, fork, scope + 1) : "Missing Fork";
        }
    }

    private display_fork(ext: Ext, entity: Entity, fork: Fork.Fork, scope: number): string {
        let fmt = `Fork(${entity}) [${fork.area.array}]: {\n`;

        fmt += ' '.repeat((1 + scope) * 2) + `workspace: (${fork.workspace}),\n`;
        fmt += ' '.repeat((1 + scope) * 2) + 'left:  ' + this.display_branch(ext, fork.left, scope) + ',\n';

        if (fork.right) {
            fmt += ' '.repeat((1 + scope) * 2) + 'right: ' + this.display_branch(ext, fork.right, scope) + ',\n';
        }

        fmt += ' '.repeat(scope * 2) + '}';
        return fmt;
    }
}
